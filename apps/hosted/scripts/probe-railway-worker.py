"""Synthetic Railway worker probe: authenticated WebDriver over private IPv6."""
import base64
import json
import sys
from urllib.request import Request, build_opener, ProxyHandler


def main(endpoint: str, token: str) -> None:
    opener = build_opener(ProxyHandler({}))

    def command(method: str, path: str, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        request = Request(
            endpoint + path,
            data=body,
            method=method,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        with opener.open(request, timeout=30) as response:
            return json.load(response)["value"]

    opened = command("POST", "/session", {
        "capabilities": {"alwaysMatch": {
            "browserName": "chrome",
            "goog:chromeOptions": {
                "binary": "/usr/bin/chromium",
                "args": [
                    "--headless=new",
                    "--no-first-run",
                    "--proxy-server=http://recorder-egress:37843",
                    "--proxy-bypass-list=<-loopback>",
                    "--disable-quic",
                ],
            },
        }},
    })
    session_id = opened["sessionId"]
    try:
        base = "/session/" + session_id
        command("POST", base + "/url", {"url": "https://www.selenium.dev/selenium/web/web-form.html"})
        title = command("GET", base + "/title")
        screenshot = base64.b64decode(command("GET", base + "/screenshot"), validate=True)
        if title != "Web form" or not screenshot.startswith(b"\x89PNG"):
            raise RuntimeError("worker_navigation_result_invalid")
        print(json.dumps({"phase": "railway_private_worker_browser_ready", "title": title,
                          "screenshotBytes": len(screenshot)}))
    finally:
        command("DELETE", "/session/" + session_id)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: probe-railway-worker.py PRIVATE_ENDPOINT SYNTHETIC_TOKEN")
    main(sys.argv[1], sys.argv[2])
