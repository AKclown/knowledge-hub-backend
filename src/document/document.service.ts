import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentDto } from './dto/query-document.dto';
import { DocumentEntity } from './entities/document.entity';
import { DocumentStatus } from './document-status';
import {
  DocumentContent,
  DocumentContentDocument,
} from './schemas/document-content.schema';

/** 文档元数据存储在 PostgreSQL，正文存储在 MongoDB。 */
@Injectable()
export class DocumentService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
  ) {}

  /** 创建文档；元数据保存失败时回滚 Mongo 正文。 */
  async create(dto: CreateDocumentDto) {
    const id = nextSnowflakeId();
    const status = dto.status ?? DocumentStatus.Draft;
    const contentDoc = await this.contentModel.create({
      documentId: id,
      content: dto.content,
      contentLength: dto.content.length,
      contentSummary: dto.summary ?? this.buildContentSummary(dto.content),
      version: 1,
      deleted: false,
    });

    try {
      const doc = this.em.create(DocumentEntity, {
        id,
        title: dto.title,
        contentId: String(contentDoc._id),
        summary: dto.summary,
        categoryId: dto.categoryId,
        teamId: dto.teamId,
        coverImage: dto.coverImage,
        tags: dto.tags,
        status,
        remark: dto.remark,
        isPublic: dto.isPublic ?? false,
        wordCount: this.countWords(dto.content),
        publishTime: status === DocumentStatus.Published ? new Date() : null,
        deleted: false,
      });
      const saved = await this.em.save(doc);
      return { ...saved, content: dto.content };
    } catch (error) {
      await this.contentModel.deleteOne({ _id: contentDoc._id });
      throw error;
    }
  }

  /** 分页查询文档元数据，不含正文。 */
  async findAll(query: QueryDocumentDto = {}) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.em
      .createQueryBuilder(DocumentEntity, 'doc')
      .where('doc.deleted = :deleted', { deleted: false });

    if (query.title) {
      qb.andWhere('doc.title ILIKE :title', { title: `%${query.title}%` });
    }
    if (query.categoryId) {
      qb.andWhere('doc.category_id = :categoryId', {
        categoryId: query.categoryId,
      });
    }
    if (query.teamId) {
      qb.andWhere('doc.team_id = :teamId', { teamId: query.teamId });
    }
    if (query.authorId) {
      qb.andWhere('doc.author_id = :authorId', { authorId: query.authorId });
    }
    if (query.status !== undefined) {
      qb.andWhere('doc.status = :status', { status: query.status });
    }

    qb.orderBy('doc.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  /** 查询详情，可选择是否包含正文。 */
  async findOne(id: string, withContent = true) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    if (!withContent) {
      return doc;
    }

    return { ...doc, content: await this.loadContent(doc.contentId) };
  }

  /** 更新文档；正文变更时同步字数、摘要和版本号。 */
  async update(id: string, dto: UpdateDocumentDto) {
    const doc = await this.findOne(id, false);

    if (dto.content !== undefined) {
      const result = await this.contentModel.updateOne(
        // 查询条件
        { _id: doc.contentId, deleted: false },
        // 设置新内容
        {
          $set: {
            content: dto.content,
            contentLength: dto.content.length,
            contentSummary:
              dto.summary ?? this.buildContentSummary(dto.content),
          },
          // 数值递增
          $inc: { version: 1 },
        },
      );
      if (result.matchedCount === 0) {
        throw new BadRequestException(
          `Document content ${doc.contentId} not found`,
        );
      }
      doc.wordCount = this.countWords(dto.content);
    } else if (dto.summary !== undefined) {
      await this.contentModel.updateOne(
        { _id: doc.contentId, deleted: false },
        { $set: { contentSummary: dto.summary } },
      );
    }

    if (dto.title !== undefined) doc.title = dto.title;
    if (dto.summary !== undefined) doc.summary = dto.summary;
    if (dto.categoryId !== undefined) doc.categoryId = dto.categoryId;
    if (dto.teamId !== undefined) doc.teamId = dto.teamId;
    if (dto.coverImage !== undefined) doc.coverImage = dto.coverImage;
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.status !== undefined) doc.status = dto.status;
    if (dto.remark !== undefined) doc.remark = dto.remark;
    if (dto.isPublic !== undefined) doc.isPublic = dto.isPublic;

    const saved = await this.em.save(doc);
    const content = dto.content ?? (await this.loadContent(doc.contentId));
    return { ...saved, content };
  }

  /** 软删除文档，同时标记 PostgreSQL 元数据和 Mongo 正文。 */
  async remove(id: string) {
    const doc = await this.findOne(id, false);
    doc.deleted = true;
    await this.em.save(doc);
    await this.contentModel.updateOne(
      { _id: doc.contentId },
      { $set: { deleted: true } },
    );
    return { id, deleted: true };
  }

  private async loadContent(contentId: string): Promise<string> {
    const contentDoc = await this.contentModel
      .findOne({ _id: contentId, deleted: false })
      .lean();
    return contentDoc?.content ?? '';
  }

  private buildContentSummary(content: string, maxLen = 200): string {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxLen
      ? trimmed
      : `${trimmed.slice(0, maxLen)}...`;
  }

  /** 汉字逐字计数，其余文本按空白分词。 */
  private countWords(content: string): number {
    const trimmed = content.trim();
    if (!trimmed) return 0;

    const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latin = trimmed
      .replace(/[\u4e00-\u9fff]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    return cjk + latin;
  }
}
