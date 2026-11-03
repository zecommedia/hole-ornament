"""
Quick CLI tester for the RMBG server (no external deps — stdlib only).

Usage:
  python test-rmbg.py                      # chỉ kiểm tra /health
  python test-rmbg.py <input.png>          # tách nền, lưu <input>_nobg.png
  python test-rmbg.py <input.png> <out.png>

Env: RMBG_PORT (default 5001).
Tip: chạy qua test-rmbg.bat để tự dùng python trong venv.
"""
import sys, os, json, urllib.request, urllib.error

PORT = os.environ.get("RMBG_PORT", "5001")
BASE = f"http://127.0.0.1:{PORT}"


def _get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return r.status, r.read().decode()


def _post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.status, r.read().decode()


def main():
    # 1) health
    try:
        st, body = _get("/health")
        print(f"[health] HTTP {st}: {body}")
    except Exception as e:
        print(f"[health] LOI — server khong chay? ({e})")
        print(r"  -> mo server: py-rmbg\start-rmbg-server.bat")
        sys.exit(1)

    if len(sys.argv) < 2:
        print("\nHealth OK. De test tach nen 1 anh:")
        print(r"  test-rmbg.bat <duong-dan-anh.png> [output.png]")
        return

    # 2) background removal
    inp = os.path.abspath(sys.argv[1])
    if not os.path.exists(inp):
        print(f"[rmbg] input khong ton tai: {inp}")
        sys.exit(1)
    out = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 \
        else os.path.splitext(inp)[0] + "_nobg.png"
    print(f"[rmbg] input  = {inp}")
    print(f"[rmbg] output = {out}")
    try:
        st, body = _post("/rmbg", {"input_path": inp, "output_path": out, "fill_holes": True})
        print(f"[rmbg] HTTP {st}: {body}")
        if st == 200 and os.path.exists(out):
            print(f"[rmbg] OK -> mo file de xem: {out}")
    except urllib.error.HTTPError as e:
        print(f"[rmbg] HTTP {e.code}: {e.read().decode()[:300]}")
        sys.exit(1)
    except Exception as e:
        print(f"[rmbg] LOI: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
