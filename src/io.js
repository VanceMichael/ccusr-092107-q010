// 从 fixtures 目录读取并解析 JSON 资料。
import { readFile } from "node:fs/promises";

export async function loadFixture(name) {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}
