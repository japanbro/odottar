#!/usr/bin/env python3
"""GitHub main へ変更ファイルをpushしてCloudflare自動デプロイを発火させる。

usage: python3 deploy.py [file1 file2 ...]
  引数なし: index.html, events.json, odottar_db_merged_2026.csv をデプロイ
  トークン: pipeline/.secrets/github_token（1行）または環境変数 GITHUB_TOKEN

方式: 毎回 GitHub main を depth1 で fresh clone → ローカル最新ファイルを上書き
→ commit → push。ローカルの .git には一切触れない（履歴分離事故防止）。
トークンはURLに埋めず askpass 経由で渡す（ログ漏洩防止）。
"""
import os, sys, subprocess, tempfile, shutil, datetime

REPO = "github.com/japanbro/odottar.git"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FILES = ["index.html", "events.json", "sitemap.xml", "odottar_db_merged_2026.csv"]

def token():
    p = os.path.join(ROOT, "pipeline", ".secrets", "github_token")
    if os.path.exists(p):
        return open(p).read().strip()
    t = os.environ.get("GITHUB_TOKEN")
    if not t:
        sys.exit("ERROR: トークン未設定。pipeline/.secrets/github_token に保存するか GITHUB_TOKEN を設定")
    return t

def regen_sitemap():
    """events.json から sitemap.xml を再生成し、デプロイ内容と常に一致させる。
    lastmod は events.json の mtime 基準なのでデータ不変なら出力も不変（無駄な差分なし）。"""
    gen = os.path.join(ROOT, "pipeline", "gen_sitemap.py")
    if os.path.exists(gen):
        subprocess.run([sys.executable, gen], check=True)

def main():
    files = sys.argv[1:] or DEFAULT_FILES
    # events.json を送るデプロイでは sitemap.xml を必ず追随させる
    if "events.json" in files:
        regen_sitemap()
        if "sitemap.xml" not in files:
            files = files + ["sitemap.xml"]
    tok = token()
    tmp = tempfile.mkdtemp(prefix="odottar_deploy_")
    try:
        # askpass: トークンをコマンドラインやリモートURLに残さない
        askpass = os.path.join(tmp, "askpass.sh")
        open(askpass, "w").write("#!/bin/sh\necho \"$GIT_TOKEN\"\n")
        os.chmod(askpass, 0o700)
        env = dict(os.environ, GIT_ASKPASS=askpass, GIT_TOKEN=tok,
                   GIT_TERMINAL_PROMPT="0")
        def git(*args, cwd=None):
            r = subprocess.run(["git", *args], cwd=cwd, env=env,
                               capture_output=True, text=True)
            if r.returncode != 0:
                sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()[:500]}")
            return r.stdout
        clone_dir = os.path.join(tmp, "repo")
        git("clone", "--depth", "1", f"https://x-access-token@{REPO}", clone_dir)
        changed = []
        for f in files:
            src = os.path.join(ROOT, f)
            if not os.path.exists(src):
                print(f"skip (not found): {f}")
                continue
            dst = os.path.join(clone_dir, f)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.exists(dst) and open(src, "rb").read() == open(dst, "rb").read():
                print(f"unchanged: {f}")
                continue
            shutil.copy(src, dst)
            changed.append(f)
        if not changed:
            print("変更なし。デプロイ不要")
            return
        git("config", "user.email", "odottar-bot@users.noreply.github.com", cwd=clone_dir)
        git("config", "user.name", "odottar auto-update", cwd=clone_dir)
        git("add", *changed, cwd=clone_dir)
        msg = f"auto-update {datetime.date.today().isoformat()}: {', '.join(changed)}"
        git("commit", "-m", msg, cwd=clone_dir)
        git("push", "origin", "HEAD", cwd=clone_dir)
        print(f"デプロイ完了: {msg}\nCloudflareが数分で自動反映 → https://odottar.com")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()
