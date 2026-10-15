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
const profileDir = await mkdtemp(path.join(os.tmpdir(), "org-chart-interim-"));
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
    const headers = ["组织1","组织2","组织3","组织4","姓名","岗位","层级","兼管分组","显示顺序"];
    const rows = [
      ["甲公司","甲公司","甲公司","","张三","中心副总监","中心副总监","产品开发部",0],
      ["甲公司","产品开发部","固体产品组","粉剂1组","李四","组长","组长","",1],
      ["甲公司","产品开发部","固体产品组","粉剂1组","王五","工程师","骨干","",2],
      ["乙公司","项目部","项目部","项目组","赵六","组长","组长","",3]
    ];
    const render = (fixture, frame = false, masked = false) => {
      document.querySelector("#data").value = "";
      clearAll();
      document.querySelector("#data").value = [headers, ...fixture].map(row => row.join("\t")).join("\n");
      document.querySelector("#frameOnly").checked = frame;
      document.querySelector("#maskName").checked = masked;
      run();
      return {
        bindings: Object.fromEntries(Object.entries(window._cenExt || {}).map(([c, p]) => [c, p.姓名])),
        topNames: lastModel.TOPS.map(p => p.姓名),
        peopleCount: lastModel.people.length,
        text: [...document.querySelectorAll("#chartbox svg text")].map(node => node.textContent),
        hints: window._structFixes || [],
      };
    };
    const shortName = render(rows);
    const fullNameRows = rows.map(row => [...row]);
    fullNameRows[0][7] = "甲公司·产品开发部";
    const fullName = render(fullNameRows);
    const masked = render(rows, false, true);
    const frame = render(rows, true);
    const ambiguousRows = [...rows, ["乙公司","产品开发部","液体产品组","饮料组","钱七","组长","组长","",4]];
    const ambiguous = render(ambiguousRows);
    const exactRows = ambiguousRows.map(row => [...row]);
    exactRows[0][7] = "甲公司·产品开发部";
    const exact = render(exactRows);
    // 已有正式负责人时，暂管标记不能替换该负责人。
    const assignedRows = rows.map(row => [...row]);
    assignedRows[0][5] = assignedRows[0][6] = "总经理";
    assignedRows.push(["甲公司","产品开发部","","","孙八","中心总监","中心总监","",5]);
    const assigned = render(assignedRows);
    assigned.centerHeads = lastModel.cenHeads["甲公司·产品开发部"].map(p => p.姓名);
    return { shortName, fullName, masked, frame, ambiguous, exact, assigned };
  })()`;

  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const value = result.result.value;
  for (const result of [value.shortName, value.fullName]) {
    assert.equal(result.bindings["甲公司·产品开发部"], "张三", "short and canonical unit names must bind the same interim manager");
    assert(result.text.includes("负责人暂缺"), "an interim-managed unit must retain the vacant leader card without peer heads");
    assert(result.text.includes("现由 张三 暂管"), "the vacant leader card must show who temporarily manages the unit");
    assert(result.topNames.includes("张三"), "temporary management must preserve the person's primary leadership position");
    assert.equal(result.peopleCount, 4, "temporary management must not duplicate personnel records");
    assert(!result.hints.some(hint => hint.includes("表里没有叫这个名字")), "a valid short name must not be reported as nonexistent");
  }
  assert(value.masked.text.includes("现由 张X 暂管"), "temporary manager labels must respect name masking");
  assert(!value.masked.text.some(text => text.includes("张三")), "masked charts must not leak the interim manager's full name");
  assert(value.frame.text.some(text => text.includes("张三 兼管")), "frame charts must retain the temporary management annotation");
  assert(!value.frame.text.includes("负责人暂缺"), "frame charts must omit personnel placeholder cards");
  assert.deepEqual(value.ambiguous.bindings, {}, "an ambiguous short unit name must not bind an arbitrary center");
  assert(value.ambiguous.hints.some(hint => hint.includes("同名") && hint.includes("完整")), "ambiguous short names must request the full unit name");
  assert.equal(value.exact.bindings["甲公司·产品开发部"], "张三", "exact canonical names must resolve even when short names are ambiguous");
  assert.equal(value.exact.bindings["乙公司·产品开发部"], undefined, "temporary management must not spill into another similarly named unit");
  assert.deepEqual(value.assigned.bindings, {}, "an assigned center head must not be overridden by temporary management");
  assert.deepEqual(value.assigned.centerHeads, ["孙八"]);
  console.log("PASS: joined unit names preserve interim management, vacant cards, masking, and assigned heads");
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
