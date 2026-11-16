"""Snapshot/restore the local isolated demo database. Run from repository root.

配置路径不再写死：用 `--config=<runtime.json>` 或环境变量 `PETQA_CONFIG` 指定，
配置由 `tools/qa_env.py init` 生成。快照与校验文件写在配置文件同目录的 snapshots/ 下，
恢复完成后调用 `tools/qa_env.py start` 重新拉起后端（原先依赖 .tmp 里的 resume.py）。
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
QA_ENV = ROOT / 'tools/qa_env.py'


def config_path(argv):
    """支持 --config <path> 与 --config=<path>，也可用 PETQA_CONFIG。返回 (路径, 剩余参数)。"""
    if '--config' in argv:
        index = argv.index('--config')
        if index + 1 >= len(argv):
            raise SystemExit('--config 缺少取值')
        return pathlib.Path(argv[index + 1]), argv[:index] + argv[index + 2:]
    for index, arg in enumerate(argv):
        if arg.startswith('--config='):
            return pathlib.Path(arg.split('=', 1)[1]), argv[:index] + argv[index + 1:]
    if os.environ.get('PETQA_CONFIG'):
        return pathlib.Path(os.environ['PETQA_CONFIG']), argv
    raise SystemExit('缺少配置路径：设置 PETQA_CONFIG 或传 --config=<runtime.json>')


STATE = None
OUT = None


def config():
    c = json.loads(STATE.read_text())
    assert re.fullmatch(r'pet_clinic_test_[a-f0-9]{8}', c['db'])
    assert c['api'] == 'http://127.0.0.1:8082/api'
    assert sql(c, 'SELECT DATABASE(),@@port') == c['db'] + '\t3307'
    grants = sql(c, 'SHOW GRANTS').splitlines()
    assert len(grants) == 2 and 'GRANT USAGE ON *.*' in grants[0]
    assert f'ON `{c["db"]}`.*' in grants[1]
    return c


def sql(c, query):
    return subprocess.check_output(['mysql', '--defaults-extra-file=' + c['mysqlDefaultsFile'],
                                    '-BN', '--default-character-set=utf8mb4', '-e', query],
                                   encoding='utf-8').strip()


def dump(c):
    source = pathlib.Path(c['mysqlDefaultsFile']).read_text()
    with tempfile.TemporaryDirectory(prefix='petqa-dump-') as directory:
        credentials = pathlib.Path(directory) / 'client.cnf'
        credentials.write_text('\n'.join(line for line in source.splitlines()
                                        if not line.strip().startswith('database=')))
        return subprocess.check_output(['mysqldump', '--defaults-extra-file=' + str(credentials),
            '--single-transaction', '--skip-comments', '--skip-dump-date', '--hex-blob',
            '--order-by-primary', '--set-gtid-purged=OFF', '--no-tablespaces', c['db']])


def stop_backend(c):
    subprocess.run([sys.executable, str(QA_ENV), 'stop', '--config', str(STATE)], check=True)


def main(argv):
    if not argv:
        raise ValueError('Use snapshot or restore')
    name = argv[1] if len(argv) > 1 else 'baseline'
    assert re.fullmatch(r'[a-z0-9-]+', name)
    c = config()
    OUT.mkdir(exist_ok=True)
    target = OUT / (name + '.sql')
    if argv[0] == 'snapshot':
        assert not target.exists(), 'Snapshot already exists; choose a new name'
        data = dump(c)
        target.write_bytes(data)
        (OUT / (name + '.json')).write_text(json.dumps({'db': c['db'], 'sha256': hashlib.sha256(data).hexdigest()}))
        print('SNAPSHOT', name, c['db'], hashlib.sha256(data).hexdigest())
    elif argv[0] == 'restore':
        data = target.read_bytes()
        meta = json.loads((OUT / (name + '.json')).read_text())
        assert meta == {'db': c['db'], 'sha256': hashlib.sha256(data).hexdigest()}
        stop_backend(c)
        subprocess.run(['mysql', '--defaults-extra-file=' + c['mysqlDefaultsFile'], c['db']], input=data, check=True)
        restored = dump(c)
        assert restored == data, 'Database differs from snapshot; backend remains stopped'
        print('RESTORE VERIFIED', name, meta['sha256'])
        subprocess.run([sys.executable, str(QA_ENV), 'start', '--config', str(STATE)], check=True)
    else:
        raise ValueError('Use snapshot or restore')


if __name__ == '__main__':
    STATE, ARGS = config_path(sys.argv[1:])
    STATE = STATE.resolve()
    OUT = STATE.parent / 'snapshots'
    main(ARGS)
