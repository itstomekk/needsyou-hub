# Updating this repo

When the tool changes: refresh the screenshot (`.github/readme/needs-you-hub.png` and `docs/img/needs-you-hub.png`, real app, no private chats), then update `README.md` and `docs/index.html`.
Run the leak scan (`leak_scan.py <repo> --all-files`) until it exits 0, stage named paths only, commit and push.
The full routine lives in the skill `github-public-repo-maintenance`.
