import { DatabaseSync } from "node:sqlite";

export function applyDiscount(total: number, code: string): number {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE discounts (code TEXT PRIMARY KEY, percent INTEGER)");
    database.prepare("INSERT INTO discounts VALUES (?, ?)").run("SAVE10", 10);
    database.prepare("INSERT INTO discounts VALUES (?, ?)").run("O'NEIL", 15);
    const query = `SELECT percent FROM discounts WHERE code = '${code}'`;
    const row = database.prepare(query).get() as { percent: number } | undefined;
    return Math.round(total * (1 - (row?.percent ?? 0) / 100));
  } finally {
    database.close();
  }
}
