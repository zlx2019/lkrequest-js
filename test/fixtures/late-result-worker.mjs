// Starts a real request and other native work that finish only after the parent has
// terminated this worker.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const native = createRequire(import.meta.url)("../../native/index.cjs");
const { url, ca } = workerData;

const session = new native.NativeClient({ caPem: [Buffer.from(ca)] }).session();
session.request({ method: "GET", url: `${url}/delay/1` }).then(() => {});
native.testing.sleep(200).then(() => {});
native.testing.externalBuffer(1 << 20, 1).then(() => {});
parentPort.postMessage("started");
