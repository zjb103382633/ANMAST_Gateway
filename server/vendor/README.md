# vendor/ucomp — universal-context-compaction 桥接

- `ucomp/`：从 [universal-context-compaction](https://github.com/mahingbun-dev/universal-context-compaction)（本地检出 /Users/maqingbin/code/universal-context-compaction）
  的 `ucomp/` 包目录拷贝（v0.1.0，纯 Python 标准库，零第三方依赖，Python ≥ 3.10）。
  升级方式：重新拷贝该目录即可。
- `ucomp_bridge.py`：网关（Node）与 ucomp 的子进程桥接，stdin/stdout JSON 协议见文件头注释。

环境变量覆盖：
- `UCOMP_HOME`：指向外部 ucomp 检出（含 `ucomp/` 包的目录），默认用本目录
- `UCOMP_PYTHON`：python 解释器路径，默认 `python3`
