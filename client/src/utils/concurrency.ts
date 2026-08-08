// 并发受限的 map：同时最多跑 `limit` 个异步任务，全部完成才 resolve。
// 单个任务失败不影响其他任务（各自在 fn 内自行处理错误），结果按输入顺序返回。
//
// 用于上传：一次选 N 个文件，最多同时上传 `limit` 个（默认 10），其余排队。

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }

  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
