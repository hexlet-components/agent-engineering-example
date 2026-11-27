import { Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { queue } from "./contract";
async function main() {
  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: queue,
    maxConcurrentActivityTaskExecutions: Number(process.env.ACTIVITY_SLOTS || 1),
  });
  await worker.run();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
