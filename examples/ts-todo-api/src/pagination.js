/**
 * 分页工具。
 *
 * 注意：这里保留了一个已知缺陷——当总数不能被 pageSize 整除时，
 * 最后一页会与上一页重叠（数据重复）。基准任务 R2 就是修它。
 * 有一个专门的回归测试文件 test/known-bugs.mjs 演示该问题（默认测试不跑它）。
 */
export const DEFAULT_PAGE_SIZE = 3
export const MAX_PAGE_SIZE = 10

export function normalizePaging(page, pageSize) {
  const parsedPage = Number.parseInt(page, 10)
  const parsedSize = Number.parseInt(pageSize, 10)
  const safePage = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1
  const safeSize = Number.isFinite(parsedSize) && parsedSize >= 1 ? Math.min(parsedSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
  return { page: safePage, pageSize: safeSize }
}

/**
 * 返回当前页的待办。
 *
 * 已知缺陷：为了让"最后一页也显示满一页"，start 被夹到 length - pageSize，
 * 导致最后一页与前一页重叠。修复时请改成"只返回剩余条目"，
 * 并保证同一 createdAt 的条目按 id 稳定排序（见基准任务的隐藏需求）。
 */
export function paginate(items, page, pageSize) {
  const { page: safePage, pageSize: safeSize } = normalizePaging(page, pageSize)
  const start = Math.min((safePage - 1) * safeSize, Math.max(0, items.length - safeSize))
  const end = start + safeSize
  return items.slice(start, end)
}

/** 默认排序：新创建的在前；createdAt 相同时按插入顺序（不稳定，隐藏需求要求按 id）。 */
export function sortTodos(todos) {
  return [...todos].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function buildPage(todos, page, pageSize) {
  const sorted = sortTodos(todos)
  const { page: safePage, pageSize: safeSize } = normalizePaging(page, pageSize)
  const items = paginate(sorted, safePage, safeSize)
  return {
    items,
    page: safePage,
    pageSize: safeSize,
    total: sorted.length,
    hasNext: safePage * safeSize < sorted.length,
  }
}
