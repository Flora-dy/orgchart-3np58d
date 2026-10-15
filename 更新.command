#!/bin/bash
# 双击运行：把工具包里最新的浏览器版同步到网站并发布
cd "$(dirname "$0")" || exit 1
SRC="/Users/zzp/Downloads/应用技术中心架构/组织架构生成工具包"

echo "① 同步最新版本…"
cp "$SRC/组织架构生成器-免安装浏览器版.html" index.html || { echo "找不到源文件"; read -r; exit 1; }
cp "$SRC/人员信息填写模板.xlsx" . 2>/dev/null
cp "$SRC/公司架构图生成器.html" company.html || { echo "找不到公司架构图生成器"; read -r; exit 1; }
cp "$SRC/公司架构填写模板.xlsx" . 2>/dev/null

echo "② 检查有没有混进真实人名…"
python3 check_privacy.py || { echo; echo "⚠️ 发布已中止，请先处理上面的问题。"; read -r; exit 1; }

if git diff --quiet && git diff --cached --quiet; then
  echo "没有改动，无需发布。"; read -r; exit 0
fi

echo "③ 发布…"
git add -A
git commit -m "更新 $(date '+%Y-%m-%d %H:%M')"
git push && echo "✅ 已发布，等 1 分钟左右生效" || echo "❌ 推送失败，看上面的提示"
echo
echo "按回车关闭"
read -r
