#!/bin/sh
# verify 一次性服务入口：任一环节失败即以非零退出码退出。
set -eu

echo "== [1/4] 代码检查：TypeScript 类型 =="
npm run typecheck

echo "== [2/4] 代码检查：算法裁决单元测试 =="
npm test

echo "== [3/4] 构建：vite 生产构建 =="
npm run build

echo "== [4/4] HTTP 冒烟：健康检查、静态资源与经 HTTP 取件的裁决复核 =="
BASE_URL="${BASE_URL:-http://web:80}" node --import tsx scripts/smoke.ts

echo ""
echo "✅ VERIFY 全部通过：代码 / 构建 / HTTP 冒烟"
