"""隔离测试环境入口：准备、校验、启动、停止。

把原先散在 `.tmp/` 里的手工步骤收敛成一条可重复的链路：

    prepare → check → start →（跑回归）→ stop

设计约束（都是踩过的坑）：

* 建库、建账号、导入结构必须用管理员凭据，并且管理员必须连在 3307 上——
  误连 3306 会把测试库建到本机业务实例里。
* 被测应用必须用 prepare 生成的**同一套受限账号**启动，不能继承环境里的
  DB_USERNAME/DB_PASSWORD（那可能是 root，也可能与校验用的身份不同）。
* 01_schema.sql 里写死了 `DROP DATABASE pet_clinic`，直接导入会删掉业务库。
  导入前必须改写成测试库并校验，校验不过就不执行。
* 启动失败不能留下 PID：否则下一次 start 要求先 stop，而 stop 又找不到进程。

用法：
    python tools/qa_env.py prepare --config <runtime.json> --db pet_clinic_test_ab12cd34 \
        --admin-defaults-file <root.cnf> [--jar <jar>]
    python tools/qa_env.py check   --config <runtime.json>
    python tools/qa_env.py start   --config <runtime.json>
    python tools/qa_env.py stop    --config <runtime.json>
    python tools/qa_env.py status  --config <runtime.json>
    python tools/qa_env.py selftest [--config <runtime.json>]

前置条件（prepare 只检查、不安装）：3307 上有一个独立的 MySQL 实例，以及一份能建库建号的
`[client]` 凭据文件。本机自建实例的参考命令：

    mysqld --initialize-insecure --datadir=C:/temp/petqa-data
    mysqld --datadir=C:/temp/petqa-data --port=3307 --bind-address=127.0.0.1 --mysqlx=0 \
           --console --pid-file=C:/temp/petqa-data/mysqld.pid

隔离实例刻意不占用 3306：管理员凭据的端口不是 3307 时 prepare 直接拒绝，
避免把 DROP/CREATE DATABASE 打到业务库上。
"""
import argparse
import http.server
import json
import os
import pathlib
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DB_NAME = re.compile(r'pet_clinic_test_[a-f0-9]{8}')
API = 'http://127.0.0.1:8082/api'
PORT = 3307

ACTORS = {
    'admin': ('admin_user', 'admin'),
    'doctor01': ('admin_user', 'doctor01'),
    'doctor02': ('admin_user', 'doctor02'),
    'zhangsan': ('sys_user', 'zhangsan'),
    'lisi': ('sys_user', 'lisi'),
}


class ConfigError(Exception):
    pass


# ---------------------------------------------------------------- 配置

def load(path):
    path = pathlib.Path(path)
    if not path.exists():
        raise ConfigError(f'配置不存在：{path}；先运行 prepare')
    return path, json.loads(path.read_text(encoding='utf-8'))


def save(path, c):
    pathlib.Path(path).write_text(json.dumps(c, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def validate_shape(c):
    """纯形状校验：不连库，任何写操作之前先过这一关。"""
    if not DB_NAME.fullmatch(c.get('db') or ''):
        raise ConfigError(f'库名必须是 pet_clinic_test_<8位小写hex>，实际为 {c.get("db")!r}')
    if c.get('api') != API:
        raise ConfigError(f'后端地址必须是 {API}，实际为 {c.get("api")!r}')
    if not c.get('mysqlDefaultsFile'):
        raise ConfigError('配置缺少 mysqlDefaultsFile')
    return c


def ini_value(path, key):
    """从 mysql 选项文件里取 [client] 段的一个值。"""
    section = None
    for raw in pathlib.Path(path).read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            section = line.strip('[]').strip().lower()
            continue
        if section == 'client' and '=' in line:
            name, value = line.split('=', 1)
            if name.strip().lower() == key:
                return value.strip().strip('"').strip("'")
    return None


def client_credentials(c):
    path = c['mysqlDefaultsFile']
    user = ini_value(path, 'user')
    password = ini_value(path, 'password')
    if not user or password is None:
        raise ConfigError(f'{path} 缺少 [client] user/password')
    return user, password


def db_user(c):
    return c.get('dbUser') or client_credentials(c)[0]


# ---------------------------------------------------------------- 数据库访问

def _mysql(cnf, query, database=None):
    command = ['mysql', '--defaults-extra-file=' + str(cnf), '-BN', '--default-character-set=utf8mb4']
    if database:
        command.append(database)
    try:
        result = subprocess.run(command + ['-e', query], capture_output=True, text=True,
                                encoding='utf-8', errors='replace')
    except FileNotFoundError as error:
        raise ConfigError('找不到 mysql 客户端，请确认它在 PATH 上') from error
    if result.returncode != 0:
        # 连不上、账号无权限都归到这里：必须在任何写操作之前变成可读的失败
        detail = [line for line in (result.stderr or '').splitlines() if line.strip()]
        raise ConfigError(f'数据库连接或授权校验失败：{detail[-1] if detail else result.returncode}')
    return result.stdout.strip()


def sql(c, query):
    """受限账号。只用于校验与读取，不能建库建号。"""
    return _mysql(c['mysqlDefaultsFile'], query)


def admin_sql(cnf, query):
    return _mysql(cnf, query)


def validate_grants(grants, db):
    """授权必须是"仅 USAGE + 仅该库"两条：多一条全局权限就说明这不是隔离账号。"""
    if len(grants) != 2 or 'GRANT USAGE ON *.*' not in grants[0] or f'ON `{db}`.*' not in grants[1]:
        raise ConfigError(f'账号权限不是"仅该库"的受限授权：{grants!r}')
    return grants


def verify_server(c):
    """实连校验：落点库、端口、账号与授权都必须对得上，否则拒绝继续。"""
    user, _ = client_credentials(c)
    expected_user = db_user(c)
    if user != expected_user:
        raise ConfigError(f'凭据文件里的账号 {user} 与配置 dbUser={expected_user} 不一致')
    actual = sql(c, 'SELECT DATABASE(), @@port, CURRENT_USER()').split('\t')
    if len(actual) != 3 or actual[0] != c['db'] or actual[1] != str(PORT):
        raise ConfigError(f'连接落点不符：期望 {c["db"]}@{PORT}，实际 {actual}')
    if not actual[2].startswith(expected_user + '@'):
        raise ConfigError(f'实际登录账号不符：期望 {expected_user}，实际 {actual[2]}')
    validate_grants(sql(c, 'SHOW GRANTS').splitlines(), c['db'])
    return c


# ---------------------------------------------------------------- 导入脚本改写

def rewrite_sql(text, db):
    """把写死的 pet_clinic 改写成测试库。只改数据库级语句，表语句不动。"""
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith('DROP DATABASE'):
            out.append(f'DROP DATABASE IF EXISTS `{db}`;')
        elif upper.startswith('CREATE DATABASE'):
            out.append(f'CREATE DATABASE `{db}` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;')
        elif upper.startswith('USE '):
            out.append(f'USE `{db}`;')
        else:
            out.append(line)
    return '\n'.join(out) + '\n'


def validate_sql(text, db, name):
    """执行前校验：语句里不能再出现旧的库名，数据库级语句只能指向测试库。"""
    code = '\n'.join(line for line in text.splitlines() if not line.strip().startswith('--'))
    # pet_clinic 后面跟 _ 属于测试库名的一部分；单独出现的旧库名一律拒绝
    if re.search(r'pet_clinic(?![\w])', code):
        raise ConfigError(f'{name} 仍包含旧库名 pet_clinic，拒绝导入')
    for match in re.finditer(r'(?i)\b(DROP|CREATE)\s+DATABASE[^;]*;', code):
        if f'`{db}`' not in match.group(0):
            raise ConfigError(f'{name} 的数据库语句未指向测试库：{match.group(0)}')
    for match in re.finditer(r'(?im)^\s*USE\s+[^;]+;', code):
        if f'`{db}`' not in match.group(0):
            raise ConfigError(f'{name} 的 USE 未指向测试库：{match.group(0)}')
    return text


def build_import(path, db):
    text = pathlib.Path(path).read_text(encoding='utf-8')
    return validate_sql(rewrite_sql(text, db), db, pathlib.Path(path).name)


def run_sql(cnf, text, database=None):
    command = ['mysql', '--defaults-extra-file=' + str(cnf), '--default-character-set=utf8mb4']
    if database:
        command.append(database)
    subprocess.run(command, input=text.encode('utf-8'), check=True)


# ---------------------------------------------------------------- 准备

def prepare(args):
    db = args.db
    validate_shape({'db': db, 'api': API, 'mysqlDefaultsFile': 'pending'})
    config_path = pathlib.Path(args.config)
    # prepare 会 DROP/CREATE 测试库并重设口令，后端还连着的时候不能做
    if config_path.exists():
        try:
            existing = json.loads(config_path.read_text(encoding='utf-8'))
            if process_state(existing.get('backendPid')) == 'ours':
                raise ConfigError('后端仍在运行，先 stop 再 prepare（prepare 会重建测试库）')
        except json.JSONDecodeError:
            pass
    config_path.parent.mkdir(parents=True, exist_ok=True)
    admin = pathlib.Path(args.admin_defaults_file)
    if not admin.exists():
        raise ConfigError(f'管理员凭据文件不存在：{admin}')

    port = admin_sql(admin, 'SELECT @@port')
    if port != str(PORT):
        raise ConfigError(f'管理员凭据必须连到隔离实例 {PORT}，当前 {port}；拒绝在业务实例上建库')

    user = args.db_user or 'petqa_' + secrets.token_hex(4)
    password = secrets.token_urlsafe(24)

    admin_sql(admin, f'CREATE DATABASE IF NOT EXISTS `{db}` '
                     f'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')
    for host in ('localhost', '127.0.0.1'):
        account = f"'{user}'@'{host}'"
        admin_sql(admin, f'CREATE USER IF NOT EXISTS {account} IDENTIFIED BY %s' % _quote(password))
        admin_sql(admin, f'ALTER USER {account} IDENTIFIED BY %s' % _quote(password))
        admin_sql(admin, f'REVOKE ALL PRIVILEGES, GRANT OPTION FROM {account}')
        admin_sql(admin, f'GRANT ALL PRIVILEGES ON `{db}`.* TO {account}')

    client = config_path.parent / 'client.cnf'
    client.write_text(
        '[client]\n'
        f'host=127.0.0.1\nport={PORT}\nuser={user}\npassword={password}\ndatabase={db}\n'
        'default-character-set=utf8mb4\n', encoding='utf-8')

    c = {'db': db, 'api': API, 'mysqlDefaultsFile': str(client), 'dbUser': user,
         'backendLog': str(config_path.parent / 'backend.log')}
    if args.jar:
        c['backendJar'] = args.jar

    schema = build_import(ROOT / 'sql/01_schema.sql', db)
    run_sql(admin, schema)
    seed = build_import(ROOT / 'sql/02_data.sql', db)
    run_sql(admin, seed, db)

    secret = config_path.parent / 'jwt-secret.txt'
    if not secret.exists():
        secret.write_text(os.urandom(48).hex(), encoding='utf-8')

    actors = read_actors(c)
    (config_path.parent / 'actors.json').write_text(
        json.dumps(actors, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

    save(config_path, c)
    verify_server(c)
    print(f'PREPARED db={db} user={user} actors={",".join(actors)}')
    print(f'  config      {config_path}')
    print(f'  credentials {client}（含口令，勿入库）')
    print(f'  secret      {secret}')


def _quote(value):
    return "'" + value.replace("'", "''") + "'"


def read_actors(c):
    """生成三套回归脚本共用的参与方契约。

    字段是脚本实际读取的并集：id/typ/role/doctorId/name/tokenVersion + side（REST 前缀）。
    少一个键，business_rules_check 或 audit_regression 会在中途才报 undefined；
    所以这里一次性列全，并在脚本启动时再做一次校验。
    """
    actors = {}
    for key, (table, username) in ACTORS.items():
        if table == 'admin_user':
            row = sql(c, 'SELECT id, role, doctor_id, real_name, token_version FROM admin_user '
                         f"WHERE username = '{username}' AND deleted = 0")
            if not row:
                raise ConfigError(f'种子数据缺少后台账号 {username}')
            uid, role, doctor_id, name, ver = row.split('\t')
            actors[key] = {'id': int(uid), 'typ': 'ADMIN', 'role': role,
                           'doctorId': None if doctor_id == 'NULL' else int(doctor_id),
                           'name': name if name != 'NULL' else username, 'tokenVersion': int(ver),
                           'side': 'admin', 'username': username}
        else:
            row = sql(c, 'SELECT id, nickname, token_version FROM sys_user '
                         f"WHERE username = '{username}' AND deleted = 0")
            if not row:
                raise ConfigError(f'种子数据缺少用户端账号 {username}')
            uid, name, ver = row.split('\t')
            actors[key] = {'id': int(uid), 'typ': 'CLIENT', 'role': 'USER', 'doctorId': None,
                           'name': name if name != 'NULL' else username, 'tokenVersion': int(ver),
                           'side': 'client', 'username': username}
    return actors


# ---------------------------------------------------------------- 启动与停止

def jdbc_url(c):
    return ('jdbc:mysql://127.0.0.1:%d/%s?useUnicode=true&characterEncoding=utf8'
            '&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true'
            '&rewriteBatchedStatements=true' % (PORT, c['db']))


def read_secret(path):
    target = pathlib.Path(path).parent / 'jwt-secret.txt'
    if not target.exists():
        raise ConfigError(f'缺少 {target}：先运行 prepare')
    value = target.read_text(encoding='utf-8').strip()
    if len(value) < 32:
        raise ConfigError(f'{target} 少于 32 字节，后端会拒绝启动')
    return value


def build_env(c, secret=None):
    """构造子进程环境：显式覆盖数据库凭据，父进程里的同名变量不能影响被测实例。"""
    user, password = client_credentials(c)
    env = dict(os.environ)
    env['DB_USERNAME'] = env['SPRING_DATASOURCE_USERNAME'] = user
    env['DB_PASSWORD'] = env['SPRING_DATASOURCE_PASSWORD'] = password
    if secret:
        env['JWT_SECRET'] = secret
    return env


def process_state(pid):
    """ours=确实是这次启动的后端；missing=进程不在；foreign=PID 被别的进程占用。"""
    if not pid:
        return 'missing'
    script = ("$p=Get-CimInstance Win32_Process -Filter 'ProcessId=%d'; "
              "if(-not $p){exit 2}; "
              "if($p.Name -ne 'java.exe' -or $p.CommandLine -notlike '*pet-clinic-server.jar*' "
              "-or $p.CommandLine -notlike '*--server.port=8082*'){exit 3}; exit 0" % int(pid))
    code = subprocess.run(['powershell', '-NoProfile', '-Command', script]).returncode
    return {0: 'ours', 2: 'missing', 3: 'foreign'}.get(code, 'foreign')


def process_commandline(pid):
    script = ("$p=Get-CimInstance Win32_Process -Filter 'ProcessId=%d'; "
              "if(-not $p){exit 2}; $p.CommandLine" % int(pid))
    result = subprocess.run(['powershell', '-NoProfile', '-Command', script],
                            capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode != 0:
        raise ConfigError(f'读取进程 {pid} 的命令行失败')
    return result.stdout.strip()


def listener_pid(port):
    """返回监听该端口的进程号；没有监听返回 None。"""
    script = (f"(Get-NetTCPConnection -LocalPort {int(port)} -State Listen "
              "-ErrorAction SilentlyContinue | Select-Object -Unique -ExpandProperty OwningProcess)")
    result = subprocess.run(['powershell', '-NoProfile', '-Command', script],
                            capture_output=True, text=True, encoding='utf-8', errors='replace')
    for line in (result.stdout or '').splitlines():
        if line.strip().isdigit():
            return int(line.strip())
    return None


def verify_instance(c):
    """确认 8082 上跑的就是配置记录的那个后端，而不是同机另一个实例。

    连接数只能证明"有客户端用这个账号连了这个库"，证明不了"8082 就是它"：
    测试后端可能跑在别的端口，而 8082 被另一个服务占用。
    所以先按 PID 对齐监听者，再核对这个 PID 的命令行。
    """
    pid = c.get('backendPid')
    if not pid:
        raise ConfigError('配置缺少 backendPid：先运行 qa_env.py start')
    pid = int(pid)
    actual = listener_pid(8082)
    if actual != pid:
        raise ConfigError(f'8082 的监听进程是 {actual}，与配置的 backendPid={pid} 不一致')
    commandline = process_commandline(pid)
    if 'pet-clinic-server.jar' not in commandline:
        raise ConfigError(f'PID {pid} 不是本项目 jar 启动的进程')
    if '--server.port=8082' not in commandline:
        raise ConfigError(f'PID {pid} 的启动命令没有使用 8082 端口')
    if jdbc_url(c) not in commandline:
        raise ConfigError(f'PID {pid} 的数据源不是测试库 {c["db"]}')
    user = db_user(c)
    count = sql(c, "SELECT COUNT(*) FROM information_schema.PROCESSLIST "
                   f"WHERE id <> CONNECTION_ID() AND user = '{user}' AND db = '{c['db']}'")
    if not count or int(count) <= 0:
        raise ConfigError(f'PID {pid} 没有以 {user} 连到 {c["db"]}')
    return {'pid': pid, 'user': user, 'connections': int(count)}


def terminate(proc):
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


def log_tail(path, lines=20):
    try:
        return '\n'.join(pathlib.Path(path).read_text(encoding='utf-8', errors='replace').splitlines()[-lines:])
    except OSError:
        return '(无日志)'


def api_ready():
    try:
        with urllib.request.urlopen(API + '/v3/api-docs', timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def launch_and_wait(path, c, cmd, timeout=60, require_api=True, env=None):
    """启动子进程并等待就绪；任何失败都要清理 PID，避免留下"幽灵运行中"。"""
    log_path = pathlib.Path(c.get('backendLog') or (pathlib.Path(path).parent / 'backend.log'))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, 'a', encoding='utf-8', errors='replace') as log:
        log.write(f"\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        log.flush()
        proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env or dict(os.environ),
                                stdout=log, stderr=subprocess.STDOUT)
    c['backendPid'] = proc.pid
    save(path, c)
    try:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                raise ConfigError(f'后端启动即退出（exit={proc.returncode}），日志尾部：\n{log_tail(log_path)}')
            if not require_api or api_ready():
                return proc
            time.sleep(0.5)
        raise ConfigError(f'后端 {timeout} 秒内未就绪，日志尾部：\n{log_tail(log_path)}')
    except BaseException:
        terminate(proc)
        c.pop('backendPid', None)
        save(path, c)
        raise


def verify_backend_identity(c, proc, timeout=15):
    """启动后核验：重复调用 {@link verify_instance}，等 8082 的监听者切到新进程。"""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            info = verify_instance(c)
            # 只输出账号与库名；口令不进命令行，也不进日志
            print(f'BACKEND VERIFIED pid={info["pid"]} user={info["user"]} '
                  f'db={c["db"]} connections={info["connections"]}')
            return info
        except ConfigError as error:
            last = error
            time.sleep(0.5)
    raise last or ConfigError('身份核验超时')


def bring_up(path, c, cmd, env, timeout=60):
    """启动 → 就绪 → 身份核验，三步共用同一个失败清理范围。

    身份核验在 launch_and_wait 之外，如果不并进来，核验失败会留下一个仍在运行、
    却已经不在任何清理路径上的进程（以及一个指向它的 backendPid）。
    """
    proc = launch_and_wait(path, c, cmd, timeout=timeout, env=env)
    try:
        verify_backend_identity(c, proc)
    except BaseException:
        terminate(proc)
        c.pop('backendPid', None)
        save(path, c)
        raise
    return proc


def start(path, c):
    validate_shape(c)
    verify_server(c)                       # 先证明凭据可用，再启动
    state = process_state(c.get('backendPid'))
    if state == 'ours':
        raise ConfigError('已有后端在运行，先执行 stop')
    if state == 'foreign':
        raise ConfigError('配置里的 backendPid 指向其他进程，先清理该项再启动')
    if state == 'missing' and c.get('backendPid'):
        c.pop('backendPid', None)
        save(path, c)

    jar = pathlib.Path(c.get('backendJar') or (ROOT / 'backend/target/pet-clinic-server.jar'))
    if not jar.exists():
        raise ConfigError(f'后端 jar 不存在：{jar}；先 mvn -f backend/pom.xml package -DskipTests')
    secret = read_secret(path)
    cmd = ['java', '-jar', str(jar), '--server.port=8082',
           '--spring.datasource.url=' + jdbc_url(c),
           '--logging.level.com.petclinic=debug']
    bring_up(path, c, cmd, build_env(c, secret))
    print(f'BACKEND STARTED pid={c["backendPid"]} user={db_user(c)} db={c["db"]}')


def stop(path, c):
    """幂等停止：进程已退出视为收尾成功；PID 指向别的进程则拒绝。"""
    pid = c.get('backendPid')
    if not pid:
        print('BACKEND ALREADY STOPPED')
        return 'already-stopped'
    state = process_state(pid)
    if state == 'foreign':
        raise ConfigError(f'PID {pid} 不是本项目后端，拒绝停止')
    if state == 'missing':
        c.pop('backendPid', None)
        save(path, c)
        print('BACKEND ALREADY STOPPED')
        return 'already-stopped'
    subprocess.run(['powershell', '-NoProfile', '-Command',
                    f'Stop-Process -Id {int(pid)} -Force'], check=True)
    c.pop('backendPid', None)
    save(path, c)
    print('BACKEND STOPPED')
    return 'stopped'


def status(path, c):
    pid = c.get('backendPid')
    print(f'pid={pid} state={process_state(pid)} reachable={api_ready()} db={c["db"]} user={db_user(c)}')


# ---------------------------------------------------------------- 自检

def negative_instance(config_path, c):
    """反向用例：被测后端跑在 8092（确实连着自己的测试库），8082 被另一个进程占用。

    这正是"库里有连接、8082 也响应，但 8082 不是被测实例"的场景。
    只看连接数会放行；verify_instance 必须按监听 PID 拒绝。
    """
    validate_shape(c)
    verify_server(c)
    jar = pathlib.Path(c.get('backendJar') or (ROOT / 'backend/target/pet-clinic-server.jar'))
    if not jar.exists():
        raise ConfigError(f'后端 jar 不存在：{jar}')
    secret = read_secret(config_path)
    log_path = pathlib.Path(config_path).parent / 'negative-8092.log'
    log = open(log_path, 'a', encoding='utf-8', errors='replace')
    proc = subprocess.Popen(
        ['java', '-jar', str(jar), '--server.port=8092', '--spring.datasource.url=' + jdbc_url(c),
         '--logging.level.com.petclinic=warn'],
        cwd=str(ROOT), env=build_env(c, secret), stdout=log, stderr=subprocess.STDOUT)
    server = None
    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            if proc.poll() is not None:
                raise ConfigError(f'8092 实例启动失败，见 {log_path}')
            try:
                urllib.request.urlopen('http://127.0.0.1:8092/api/v3/api-docs', timeout=2)
                break
            except (urllib.error.URLError, OSError):
                time.sleep(0.5)
        else:
            raise ConfigError('8092 实例 60 秒内未就绪')

        class Impostor(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的约定命名
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{}')

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(('127.0.0.1', 8082), Impostor)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        impostor = listener_pid(8082)

        user = db_user(c)
        connections = sql(c, "SELECT COUNT(*) FROM information_schema.PROCESSLIST "
                             f"WHERE id <> CONNECTION_ID() AND user = '{user}' AND db = '{c['db']}'")
        print(f'SCENARIO backend=8092(pid={proc.pid}) 8082=impostor(pid={impostor}) '
              f'api_ready={api_ready()} db_connections={connections}')

        temp = dict(c, backendPid=proc.pid)
        try:
            verify_instance(temp)
        except ConfigError as error:
            print(f'PASS 拒绝在错误实例上写入：{error}')
            return
        raise ConfigError('8082 被其他进程占用时，实例校验仍然通过')
    finally:
        if server:
            server.shutdown()
            server.server_close()
        terminate(proc)
        log.close()


def selftest(real_config=None):
    """不需要数据库的部分全部在这里验证；连库与授权由 check / --config 附加验证。"""
    failures = []

    def case(name, action, expected_error=None):
        try:
            action()
            if expected_error:
                failures.append(name)
                print('FAIL', name, '应当报错')
            else:
                print('PASS', name)
        except ConfigError as error:
            if expected_error and expected_error in str(error):
                print('PASS', name)
            else:
                failures.append(name)
                print('FAIL', name, error)
        except Exception as error:  # noqa: BLE001 - 自检要把意外异常也报出来
            failures.append(name)
            print('FAIL', name, repr(error))

    good = {'db': 'pet_clinic_test_ab12cd34', 'api': API, 'mysqlDefaultsFile': 'x.cnf'}

    # 1. 形状：库名/地址/凭据路径
    case('形状-合法', lambda: validate_shape(good))
    case('形状-业务库名', lambda: validate_shape({**good, 'db': 'pet_clinic'}), '库名必须是')
    case('形状-库名少一位', lambda: validate_shape({**good, 'db': 'pet_clinic_test_ab12cd3'}), '库名必须是')
    case('形状-库名大写', lambda: validate_shape({**good, 'db': 'pet_clinic_test_AB12CD34'}), '库名必须是')
    case('形状-非隔离端口', lambda: validate_shape({**good, 'api': 'http://127.0.0.1:8081/api'}), '后端地址必须是')
    case('形状-缺凭据路径', lambda: validate_shape({**good, 'mysqlDefaultsFile': ''}), 'mysqlDefaultsFile')

    # 2. 导库脚本改写：旧库名必须消失，数据库级语句必须指向测试库
    schema = 'DROP DATABASE IF EXISTS `pet_clinic`;\nCREATE DATABASE `pet_clinic`;\nUSE `pet_clinic`;\nCREATE TABLE t (id INT);'
    rewritten = validate_sql(rewrite_sql(schema, 'pet_clinic_test_ab12cd34'), 'pet_clinic_test_ab12cd34', '01_schema.sql')
    if '`pet_clinic_test_ab12cd34`' in rewritten and not re.search(r'pet_clinic(?![\w])', rewritten):
        print('PASS 改写-建库指向测试库')
    else:
        failures.append('改写-建库指向测试库')
        print('FAIL 改写-建库指向测试库')
    case('改写-拒绝遗留旧库名',
         lambda: validate_sql('USE `pet_clinic`;', 'pet_clinic_test_ab12cd34', '02_data.sql'), '旧库名')

    # 3. 授权形状：多一条全局权限就不是隔离账号
    db = 'pet_clinic_test_ab12cd34'
    case('授权-仅 USAGE 与单库',
         lambda: validate_grants([f'GRANT USAGE ON *.* TO `u`@`localhost`',
                                  f'GRANT ALL PRIVILEGES ON `{db}`.* TO `u`@`localhost`'], db))
    case('授权-越权全局 SELECT',
         lambda: validate_grants([f'GRANT USAGE ON *.* TO `u`@`localhost`',
                                  'GRANT SELECT ON *.* TO `u`@`localhost`',
                                  f'GRANT ALL PRIVILEGES ON `{db}`.* TO `u`@`localhost`'], db),
         '受限授权')
    case('授权-权限落在别的库',
         lambda: validate_grants([f'GRANT USAGE ON *.* TO `u`@`localhost`',
                                  'GRANT ALL PRIVILEGES ON `pet_clinic`.* TO `u`@`localhost`'], db),
         '受限授权')

    # 4. 环境变量里存在其他数据库凭据时，子进程仍用受限账号
    with_temp = pathlib.Path(os.environ.get('TEMP', '.')) / ('qa-selftest-%d' % os.getpid())
    with_temp.mkdir(exist_ok=True)
    cnf = with_temp / 'client.cnf'
    cnf.write_text('[client]\nuser=petqa_test\npassword=restricted-pass\ndatabase=pet_clinic_test_ab12cd34\n',
                   encoding='utf-8')
    polluted = {'db': 'pet_clinic_test_ab12cd34', 'api': API, 'mysqlDefaultsFile': str(cnf),
                'dbUser': 'petqa_test'}
    saved = dict(os.environ)
    try:
        os.environ.update({'DB_USERNAME': 'root', 'DB_PASSWORD': 'root',
                           'SPRING_DATASOURCE_USERNAME': 'root', 'SPRING_DATASOURCE_PASSWORD': 'root'})
        env = build_env(polluted, 's' * 48)
        if (env['DB_USERNAME'], env['DB_PASSWORD'], env['SPRING_DATASOURCE_USERNAME'],
                env['SPRING_DATASOURCE_PASSWORD']) == ('petqa_test', 'restricted-pass',
                                                       'petqa_test', 'restricted-pass'):
            print('PASS 环境变量污染-仍用受限账号')
        else:
            failures.append('环境变量污染-仍用受限账号')
            print('FAIL 环境变量污染-仍用受限账号')
    finally:
        os.environ.clear()
        os.environ.update(saved)

    # 4. 停止：已退出与重复停止要收尾，PID 指向别的进程要拒绝
    cfg_path = with_temp / 'runtime.json'
    save(cfg_path, {'db': 'pet_clinic_test_ab12cd34', 'api': API,
                    'mysqlDefaultsFile': str(cnf), 'dbUser': 'petqa_test', 'backendPid': 999999})
    if stop(cfg_path, json.loads(cfg_path.read_text())) == 'already-stopped' \
            and 'backendPid' not in json.loads(cfg_path.read_text()):
        print('PASS 停止-进程已退出')
    else:
        failures.append('停止-进程已退出')
        print('FAIL 停止-进程已退出')
    if stop(cfg_path, json.loads(cfg_path.read_text())) == 'already-stopped':
        print('PASS 停止-重复停止')
    else:
        failures.append('停止-重复停止')
        print('FAIL 停止-重复停止')

    foreign = {'db': 'pet_clinic_test_ab12cd34', 'api': API,
               'mysqlDefaultsFile': str(cnf), 'dbUser': 'petqa_test', 'backendPid': os.getpid()}
    save(cfg_path, foreign)
    case('停止-拒绝其他进程', lambda: stop(cfg_path, json.loads(cfg_path.read_text())),
         '不是本项目后端')

    # 5. 启动失败必须清理 PID（这两种情况都应当抛错，抛错本身就是通过）
    for name, cmd, timeout in (
        ('启动失败-立即退出', [sys.executable, '-c', 'import sys; sys.exit(3)'], 10),
        ('启动失败-超时', [sys.executable, '-c', 'import time; time.sleep(30)'], 1),
    ):
        c = {'db': 'pet_clinic_test_ab12cd34', 'api': API, 'mysqlDefaultsFile': str(cnf),
             'dbUser': 'petqa_test', 'backendLog': str(with_temp / 'backend.log')}
        save(cfg_path, c)
        try:
            launch_and_wait(cfg_path, c, cmd, timeout=timeout, env=dict(os.environ))
            failures.append(name + '-未报错')
            print('FAIL', name, '应当抛错')
        except ConfigError:
            print('PASS', name)
        after = json.loads(cfg_path.read_text())
        if 'backendPid' in after:
            failures.append(name + '-PID 未清理')
            print('FAIL', name, 'PID 未清理')
        elif not (with_temp / 'backend.log').exists():
            failures.append(name + '-未写日志')
            print('FAIL', name, '未写日志')
        else:
            print('PASS', name + '-PID 已清理且有日志')

    # 6. 身份核验失败同样要清理：用 8082 上的假服务模拟"进程起来了但不是本项目后端"
    if api_ready():
        print('SKIP 启动失败-身份核验失败（8082 已被占用）')
    else:
        fake = [sys.executable, '-c',
                'import http.server\n'
                'class H(http.server.BaseHTTPRequestHandler):\n'
                '    def do_GET(self):\n'
                '        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")\n'
                '    def log_message(self, *args): pass\n'
                'http.server.HTTPServer(("127.0.0.1", 8082), H).serve_forever()']
        c = {'db': 'pet_clinic_test_ab12cd34', 'api': API, 'mysqlDefaultsFile': str(cnf),
             'dbUser': 'petqa_test', 'backendLog': str(with_temp / 'backend.log')}
        save(cfg_path, c)
        try:
            bring_up(cfg_path, c, fake, dict(os.environ), timeout=15)
            failures.append('启动失败-身份核验失败')
            print('FAIL 启动失败-身份核验失败 应当抛错')
        except ConfigError:
            print('PASS 启动失败-身份核验失败')
        after = json.loads(cfg_path.read_text())
        if 'backendPid' in after:
            failures.append('启动失败-身份核验失败-PID 未清理')
            print('FAIL 启动失败-身份核验失败 PID 未清理')
        else:
            print('PASS 启动失败-身份核验失败-PID 已清理')

    # 7. 有真实配置时，额外验证落点、授权与"错误端口"必须在写操作前失败
    if real_config:
        path, c = load(real_config)
        validate_shape(c)
        case('真实库-落点与受限授权', lambda: verify_server(c))
        case('真实库-配置账号与凭据不一致',
             lambda: verify_server({**c, 'dbUser': 'root'}), '不一致')
        wrong = with_temp / 'wrong-port.cnf'
        wrong.write_text(re.sub(r'(?m)^port=.*$', 'port=3306',
                                pathlib.Path(c['mysqlDefaultsFile']).read_text(encoding='utf-8')),
                         encoding='utf-8')
        case('真实库-错误端口在写操作前退出',
             lambda: verify_server({**c, 'mysqlDefaultsFile': str(wrong)}), '失败')

    if failures:
        raise SystemExit('SELFTEST FAILED: ' + ', '.join(failures))
    print('SELFTEST PASSED（连库部分需 --config，见 check）')


# ---------------------------------------------------------------- 命令分派

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'check', 'instance', 'negative',
                                          'start', 'stop', 'status', 'selftest'])
    parser.add_argument('--config', default=os.environ.get('PETQA_CONFIG'))
    parser.add_argument('--db')
    parser.add_argument('--db-user')
    parser.add_argument('--admin-defaults-file')
    parser.add_argument('--jar')
    args = parser.parse_args()

    if args.action == 'selftest':
        return selftest(args.config)
    if not args.config:
        raise SystemExit('缺少 --config（或设置 PETQA_CONFIG）')
    if args.action == 'prepare':
        if not args.db or not args.admin_defaults_file:
            raise SystemExit('prepare 需要 --db 与 --admin-defaults-file')
        return prepare(args)

    path, c = load(args.config)
    validate_shape(c)
    if args.action == 'check':
        verify_server(c)
        print(f'CONFIG OK db={c["db"]} user={db_user(c)}')
    elif args.action == 'instance':
        verify_server(c)
        info = verify_instance(c)
        print(f'INSTANCE OK pid={info["pid"]} user={info["user"]} db={c["db"]} '
              f'connections={info["connections"]}')
    elif args.action == 'negative':
        negative_instance(path, c)
    elif args.action == 'start':
        start(path, c)
    elif args.action == 'stop':
        stop(path, c)
    else:
        status(path, c)


if __name__ == '__main__':
    try:
        main()
    except ConfigError as error:
        # 配置/连接类失败只输出一行原因，不打整段堆栈——这类错误要能直接读懂
        raise SystemExit(f'ERROR: {error}')
