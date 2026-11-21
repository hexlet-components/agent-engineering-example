import { applyDiscount } from "../pricing/discount.ts";

export function checkout(total: number, params: URLSearchParams): number {
  const code = params.get("code") ?? "";
  return applyDiscount(total, code);
}
