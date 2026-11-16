"""从 sql/01_schema.sql 生成 docs/数据模型.md。

为什么不手写这份文档：ER图.md 那份是靠人抄的，抄下来的表数、条数、索引清单每次改表都要跟着改，
上一轮就抄出了「13 张表 / 51 条字典项」这类与库里对不上的说法。这份改成生成物，数字一律现算。

用法：python tools/gen_data_model.py
"""
import io
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "sql", "01_schema.sql")
OUT = os.path.join(ROOT, "docs", "数据模型.md")

CREATE_RE = re.compile(
    r"CREATE TABLE `(\w+)` \(\n(.*?)\n\) ENGINE = InnoDB[^;]*?COMMENT = '((?:[^']|'')*)';",
    re.S)
COL_RE = re.compile(r"^\s*`(\w+)`\s+([A-Za-z]+(?:\([\d,]+\))?)\s*(.*)$")
COMMENT_RE = re.compile(r"COMMENT\s+'((?:[^']|'')*)'")
DEFAULT_RE = re.compile(r"DEFAULT\s+(NULL|'(?:[^']|'')*'|[\w()]+(?:\s+CURRENT_TIMESTAMP)?)\b")
KEY_RE = re.compile(r"^\s*(PRIMARY KEY|UNIQUE KEY|KEY)\s+(?:`(\w+)`\s*)?\(([^)]*)\)")
FK_RE = re.compile(r"\b([a-z_]+)\.id\b")
HEAD_RE = re.compile(r"^--\s*(\d+)\.\s*`?(\w+)`?\s+(.*)$")

# 成对标记：夹在中间的内容是手写的，重生成时整段搬到文件末尾，不覆盖
HAND_BEG = "<!-- 手写说明 begin -->"
HAND_END = "<!-- 手写说明 end -->"
# 标记区内手写段的固定引言行。它在标记之内、由生成器每次重写，
# 提取旧手写内容时必须剥掉，否则每跑一次就叠一份
HAND_INTRO = "下面这段是手写的逐表业务说明，重新生成本文件时会被原样保留。"


def parse(path):
    text = io.open(path, encoding="utf-8").read()
    tables = []
    for m in CREATE_RE.finditer(text):
        name, body, tcomment = m.group(1), m.group(2), m.group(3)
        preface = text[:m.start()]
        title = ""
        for h in HEAD_RE.finditer(preface):
            if h.group(2) == name:
                title = h.group(3).strip()
        cols, uniq, idx = [], {}, {}
        for line in body.split("\n"):
            k = KEY_RE.match(line)
            if k:
                kind, kname, kcols = k.group(1), k.group(2) or "", \
                    k.group(3).replace("`", "").replace(" ", "")
                if kind == "PRIMARY KEY":
                    uniq["PRIMARY"] = kcols
                elif kind == "UNIQUE KEY":
                    uniq[kname] = kcols
                else:
                    idx[kname] = kcols
                continue
            c = COL_RE.match(line)
            if not c:
                continue
            col, typ, rest = c.group(1), c.group(2), c.group(3)
            cm = COMMENT_RE.search(rest)
            dm = DEFAULT_RE.search(rest)
            cols.append({
                "name": col,
                "type": typ,
                "null": "否" if "NOT NULL" in rest else "是",
                "default": (dm.group(1) if dm else "-").replace("CURRENT_TIMESTAMP", "当前时间"),
                "comment": cm.group(1).replace("''", "'") if cm else "",
            })
        tables.append({"table": name, "title": title, "comment": tcomment.replace("''", "'"),
                       "cols": cols, "uniq": uniq, "idx": idx})
    return tables


def logical_fks(tables):
    rows = []
    for t in tables:
        for c in t["cols"]:
            m = FK_RE.search(c["comment"])
            if not (c["name"].endswith("_id") or m):
                continue
            rows.append((t["table"], c["name"], "是" if c["null"] == "否" else "否",
                         m.group(1) if m else "（注释未注明）", c["comment"]))
    return rows


def main():
    tables = parse(SRC)
    out = []
    a = out.append
    a("# 数据模型说明")
    a("")
    a("> 本文件由 `tools/gen_data_model.py` 从 `sql/01_schema.sql` 生成：**生成区不要手改**，"
      "改表之后跑一次 `python tools/gen_data_model.py` 重生成。文末「手写说明」标记之间的"
      "**手写区可以编辑，重生成时整段保留**。")
    a("")
    ncol = sum(len(t["cols"]) for t in tables)
    a("库名 `pet_clinic`，MySQL 8，字符集 `utf8mb4`，共 %d 张表、%d 个字段。" % (len(tables), ncol))
    a("")
    a("## 一个前提：没有物理外键")
    a("")
    a("`sql/01_schema.sql` 里 `FOREIGN KEY` 约束数量为 0，表间关系全部是**逻辑外键**"
      "（`xxx_id` 列加普通索引），完整性由服务层保证。这样做的取舍：")
    a("")
    a("- 两个脚本可以反复整库导入，不会被建表顺序卡住；")
    a("- 字段改名或换库不需要先 ALTER 约束；")
    a("- 代价是数据库不替你兜底，跨表写入必须留在同一个 `@Transactional` 服务方法里。")
    a("")
    nsoft = sum(1 for t in tables if any(c["name"] == "deleted" for c in t["cols"]))
    a("另有 %d 张表带 `deleted` 走逻辑删除（MyBatis-Plus 全局配置），"
      "其余 %d 张刻意不带：%s。" % (nsoft, len(tables) - nsoft,
                                    "、".join("`%s`" % t["table"] for t in tables
                                              if not any(c["name"] == "deleted" for c in t["cols"]))))
    a("")
    a("## 表清单")
    a("")
    a("| # | 表 | 中文名 | 字段 | 唯一键 | 普通索引 | 逻辑删除 |")
    a("| --- | --- | --- | --- | --- | --- | --- |")
    for i, t in enumerate(tables, 1):
        u = "、".join("`%s`" % k for k in t["uniq"] if k != "PRIMARY") or "—"
        x = "、".join("`%s`" % k for k in t["idx"]) or "—"
        a("| %d | `%s` | %s | %d | %s | %s | %s |" % (
            i, t["table"], (t["title"] or t["comment"]).split("(")[0].strip(), len(t["cols"]), u, x,
            "是" if any(c["name"] == "deleted" for c in t["cols"]) else "否"))
    a("")
    a("## 逻辑外键一览")
    a("")
    a("认列两种：列名以 `_id` 结尾，或注释里点了 `表名.id`（后者含 `publish_by`、`moderate_by`、`hidden_by` "
      "这类记责任人的列）。`目标表` 取自注释；注释没写的标为未注明，由服务层的归属校验负责。")
    a("")
    a("| 所在表 | 列 | 必填 | 目标表 | 注释 |")
    a("| --- | --- | --- | --- | --- |")
    for r in logical_fks(tables):
        a("| `%s` | `%s` | %s | %s | %s |" % (r[0], r[1], r[2], "`%s`" % r[3], r[4]))
    a("")
    a("## 逐表字段")
    a("")
    for i, t in enumerate(tables, 1):
        a("### %d. `%s` %s" % (i, t["table"], t["title"] or t["comment"]))
        a("")
        if t["comment"] and t["title"]:
            a("> %s" % t["comment"])
            a("")
        a("| 列 | 类型 | 可空 | 默认 | 注释 |")
        a("| --- | --- | --- | --- | --- |")
        for c in t["cols"]:
            a("| `%s` | %s | %s | %s | %s |" % (
                c["name"], c["type"], c["null"], c["default"], c["comment"].replace("|", "/")))
        a("")

    hand = ""
    if os.path.exists(OUT):
        prev = io.open(OUT, encoding="utf-8").read()
        hm = re.search(r"%s\n(.*?)\n%s" % (HAND_BEG, HAND_END), prev, re.S)
        if hm:
            hand = hm.group(1).strip()
            hand = re.sub(r"^(%s\n+)+" % re.escape(HAND_INTRO), "", hand)
    a(HAND_BEG)
    a("")
    a(HAND_INTRO)
    if hand:
        a("")
        a(hand)
    a("")
    a(HAND_END)
    io.open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
    print("已生成 %s：%d 张表 / %d 字段 / %d 个逻辑外键列" % (
        os.path.relpath(OUT, ROOT), len(tables), ncol, len(logical_fks(tables))))


if __name__ == "__main__":
    main()
