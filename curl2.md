# 上传并解析文档

在项目根目录执行。分类、团队和标签来自表单，不会从文件内容自动推断；请使用实际的分类和团队 ID。
不传 `summary` 时，从解析正文生成摘要并保存到 PostgreSQL 和 MongoDB。
需要手动指定摘要或封面时，可增加 `-F 'summary=自定义摘要'` 或 `-F 'coverImage=实际封面地址'`。
上传结果为草稿，`status=0`。

```bash
curl -sS -X POST http://localhost:3000/documents/upload/parse \
  -F 'file=@./test-files/申论总结课.pptx' \
  -F 'categoryId=20001' \
  -F 'teamId=30001' \
  -F 'tags=申论,总结课' \
  -F 'isPublic=false' \
  -F 'authorId=10001' \
  -F 'createBy=10001' | jq
```

```bash
DOC_ID='替换为上传响应中的 documentId'
curl -sS "http://localhost:3000/documents/${DOC_ID}" | jq
```

回归检查（不写入真实数据库或 RustFS）：

```bash
pnpm exec jest --runInBand
node -r ts-node/register --test test/document-upload.test.ts
```
