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
const profileDir = await mkdtemp(path.join(os.tmpdir(), "org-chart-chrome-"));
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
    const headers = ["组织1","组织2","组织3","组织4","姓名","岗位","层级","显示岗位","架构角色","显示顺序"];
    const rows = [
      ["微康益生菌","董事长／总经理","","","结构占位（董事长／总经理）","董事长／总经理组织占位","总经理","董事长／总经理","",10],
      ["微康益生菌","","","","结构占位（董秘办）","董秘办组织占位","部门经理","董秘办","幕僚",11],
      ["微康益生菌","","","","结构占位（总经办）","总经办组织占位","部门经理","总经办","幕僚",12],
      ["微康益生菌","副总经理（营销）","营销办","","结构占位（营销办）","营销办组织占位","部门经理","营销办","幕僚",20],
      ["微康益生菌","副总经理（营销）","国内营销中心","国内销售部","结构占位（国内销售部）","国内销售部组织占位","组长","国内销售部","组头",30],
      ["微康益生菌","副总经理（农业）","农业办","","结构占位（农业办）","农业办组织占位","部门经理","农业办","幕僚",40],
      ["微康益生菌","副总经理（农业）","动保事业部","动保销售部","结构占位（动保销售部）","动保销售部组织占位","组长","动保销售部","组头",50]
    ];
    document.querySelector("#data").value = [headers, ...rows].map(row => row.join("\t")).join("\n");
    document.querySelector("#frameOnly").checked = true;
    document.querySelector("#showCount").checked = false;
    run();
    const texts = [...document.querySelectorAll("#chartbox svg text")];
    const byText = value => texts.find(node => node.textContent === value);
    const office = byText("营销办");
    const department = byText("国内营销中心");
    const agricultureOffice = byText("农业办");
    const agricultureDepartment = byText("动保事业部");
    const marketingCenter = byText("副总经理（营销）");
    const agricultureCenter = byText("副总经理（农业）");
    const boardOffice = byText("董秘办");
    const generalOffice = byText("总经办");
    const metric = node => node ? {x:Number(node.getAttribute("x")),y:Number(node.getAttribute("y"))} : null;
    return {
      officePresent: Boolean(office),
      departmentPresent: Boolean(department),
      office: metric(office),
      department: metric(department),
      agricultureOffice: metric(agricultureOffice),
      agricultureDepartment: metric(agricultureDepartment),
      marketingCenter: metric(marketingCenter),
      agricultureCenter: metric(agricultureCenter),
      boardOffice: metric(boardOffice),
      generalOffice: metric(generalOffice),
      svgText: texts.map(node => node.textContent),
    };
  })()`;

  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const value = result.result.value;
  assert.equal(value.officePresent, true, "frame-only chart must retain the office label");
  assert.equal(value.departmentPresent, true, "frame-only chart must retain regular departments");
  assert(
    value.office.y < value.department.y && value.agricultureOffice.y < value.agricultureDepartment.y,
    `offices should be sidecars above their department rows; received ${JSON.stringify(value)}`,
  );
  assert.notEqual(value.office.x, value.agricultureOffice.x, "different branch offices must not overlap");
  assert(
    Math.abs(value.office.x - value.marketingCenter.x) < Math.abs(value.office.x - value.agricultureCenter.x),
    "营销办 should stay with the marketing reporting line",
  );
  assert(
    Math.abs(value.agricultureOffice.x - value.agricultureCenter.x) < Math.abs(value.agricultureOffice.x - value.marketingCenter.x),
    "农业办 should stay with the agriculture reporting line",
  );
  assert(value.boardOffice && value.generalOffice, "董秘办 and 总经办 must remain visible as top sidecars");
  assert(
    value.boardOffice.y < value.marketingCenter.y && value.generalOffice.y < value.marketingCenter.y,
    "top offices should sit beside the governance trunk above the VP reporting lines",
  );
  console.log("PASS: frame-only chart keeps 幕僚 offices as sidecars above the department row");
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
