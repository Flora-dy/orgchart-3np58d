import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const file = request.url === "/" ? "index.html" : request.url.slice(1);
    const body = await readFile(path.join(repoRoot, file));
    response.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

const httpPort = await freePort();
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const debugPort = await freePort();
const profileDir = await mkdtemp(path.join(os.tmpdir(), "org-chart-leader-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  `http://127.0.0.1:${httpPort}/`,
], { stdio: "ignore" });

let cdp;
try {
  const pages = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = pages.find((item) => item.type === "page");
  assert(page, "Chrome did not expose a page target");
  cdp = cdpClient(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await cdp.send("Runtime.evaluate", {
      expression: "Boolean(document.querySelector('#data'))",
      returnByValue: true,
    });
    if (ready.result.value) break;
    if (attempt === 99) throw new Error("organization chart page did not finish loading");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const expression = String.raw`(() => {
    const headers = ["中心","部门","分组","姓名","岗位","层级","架构角色","显示顺序"];
    const rows = [
      ["应用技术中心","","","周总监","中心总监","中心总监","",1],
      ["应用技术中心","产品开发部","显式组","张明确","产品工程师","骨干","组头",10],
      ["应用技术中心","产品开发部","显式组","李层级","产品组长","组长","",11],
      ["应用技术中心","产品开发部","层级组","王组长","产品组长","组长","",20],
      ["应用技术中心","产品开发部","层级组","孙工程师","产品工程师","骨干","",21],
      ["应用技术中心","产品开发部","自动组","赵骨干","高级工程师","骨干","",30],
      ["应用技术中心","产品开发部","自动组","吴工程师","产品工程师","骨干","",31],
      ["应用技术中心","产品开发部","多组长组","钱一","产品组长","组长","",40],
      ["应用技术中心","产品开发部","多组长组","钱二","产品组长","组长","",41]
    ];
    document.querySelector("#data").value = [headers, ...rows].map(row => row.join("\t")).join("\n");
    document.querySelector("#frameOnly").checked = false;
    run();
    const head = group => document.querySelector(
      '#chartbox svg g.pbox[data-head][data-grp="' + group + '"]'
    )?.dataset.name || null;
    return {
      explicit: head("显式组"),
      level: head("层级组"),
      automatic: head("自动组"),
      multiple: head("多组长组"),
      emptyLeaderLabels: [...document.querySelectorAll("#chartbox svg text")]
        .filter(node => node.textContent === "（无组负责人）").length,
    };
  })()`;

  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const value = result.result.value;
  assert.equal(value.explicit, "张明确", "架构角色=组头 must override the level-based candidate in the same group");
  assert.equal(value.level, "王组长", "a group must still recognize its 层级=组长 after another group sets an explicit leader");
  assert.equal(value.automatic, "赵骨干", "a group without a marked leader must retain the existing first-person fallback");
  assert.equal(value.multiple, "钱一", "multiple 层级=组长 candidates must resolve by the existing member order");
  assert.equal(value.emptyLeaderLabels, 0, "populated groups in this fixture must not lose their leader cards");
  console.log("PASS: group leaders resolve independently within each group");
} finally {
  cdp?.close();
  chrome.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => chrome.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  server.close();
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
