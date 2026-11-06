import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { DocumentService } from './document.service';
import { DocumentStatus } from './document-status';
import { DocumentEntity } from './entities/document.entity';
import { DocumentContentDocument } from './schemas/document-content.schema';

// Stub ESM adapter decorators; these unit tests use mocked stores.
jest.mock('@nestjs/typeorm', () => ({
  InjectEntityManager: () => () => undefined,
}));
jest.mock('@nestjs/mongoose', () => ({
  InjectModel: () => () => undefined,
  Schema: () => () => undefined,
  Prop: () => () => undefined,
  SchemaFactory: { createForClass: () => ({}) },
}));

describe('Document CRUD', () => {
  const id = '9007199254740993';
  let doc: DocumentEntity;
  let service: DocumentService;
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn<Promise<[DocumentEntity[], number]>, []>(),
  };
  const em = {
    create: jest.fn(
      (_entity: unknown, values: Partial<DocumentEntity>) => values,
    ),
    save: jest.fn((value: DocumentEntity) => Promise.resolve(value)),
    findOne: jest.fn<Promise<DocumentEntity | null>, unknown[]>(),
    createQueryBuilder: jest.fn(() => qb),
  };
  const lean = jest.fn<Promise<{ content: string } | null>, []>();
  const contentModel = {
    create: jest.fn<Promise<{ _id: string }>, unknown[]>(),
    deleteOne: jest.fn<Promise<unknown>, unknown[]>(),
    findOne: jest.fn(() => ({ lean })),
    updateOne: jest.fn<Promise<{ matchedCount: number }>, unknown[]>(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    doc = Object.assign(new DocumentEntity(), {
      id,
      title: 'Original',
      contentId: '507f1f77bcf86cd799439011',
      status: DocumentStatus.Draft,
      deleted: false,
    });
    em.findOne.mockResolvedValue(doc);
    qb.getManyAndCount.mockResolvedValue([[doc], 1]);
    contentModel.create.mockResolvedValue({ _id: doc.contentId });
    contentModel.updateOne.mockResolvedValue({ matchedCount: 1 });
    lean.mockResolvedValue({ content: 'Original content' });
    service = new DocumentService(
      em as unknown as EntityManager,
      contentModel as unknown as Model<DocumentContentDocument>,
    );
  });

  it('creates metadata and content without external services', async () => {
    const result = await service.create({
      title: 'Title',
      content: 'Hello world',
    });

    expect(result).toMatchObject({
      title: 'Title',
      content: 'Hello world',
      contentId: doc.contentId,
      status: DocumentStatus.Draft,
      wordCount: 2,
      deleted: false,
    });
    expect(contentModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: result.id, version: 1 }),
    );
  });

  it('rolls back content when metadata cannot be saved', async () => {
    const error = new Error('Postgres unavailable');
    em.save.mockRejectedValueOnce(error);

    await expect(
      service.create({ title: 'Title', content: 'Content' }),
    ).rejects.toThrow(error);
    expect(contentModel.deleteOne).toHaveBeenCalledWith({ _id: doc.contentId });
  });

  it('lists non-deleted documents using filters and pagination', async () => {
    const result = await service.findAll({
      title: 'Title',
      status: DocumentStatus.Draft,
      page: 2,
      pageSize: 5,
    });

    expect(qb.where).toHaveBeenCalledWith('doc.deleted = :deleted', {
      deleted: false,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('doc.title ILIKE :title', {
      title: '%Title%',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('doc.status = :status', {
      status: 0,
    });
    expect(qb.skip).toHaveBeenCalledWith(5);
    expect(qb.take).toHaveBeenCalledWith(5);
    expect(result).toEqual({ items: [doc], total: 1, page: 2, pageSize: 5 });
  });

  it('loads detail with content and preserves string IDs', async () => {
    await expect(service.findOne(id)).resolves.toMatchObject({
      id,
      content: 'Original content',
    });
    expect(em.findOne).toHaveBeenCalledWith(DocumentEntity, {
      where: { id, deleted: false },
    });
  });

  it.each(['findOne', 'update', 'remove'] as const)(
    '%s rejects a missing document',
    async (method) => {
      em.findOne.mockResolvedValue(null);
      const result =
        method === 'update' ? service.update(id, {}) : service[method](id);
      await expect(result).rejects.toThrow(NotFoundException);
      expect(em.save).not.toHaveBeenCalled();
      expect(contentModel.updateOne).not.toHaveBeenCalled();
    },
  );

  it('updates content and increments its version, including empty content', async () => {
    await expect(service.update(id, { content: '' })).resolves.toMatchObject({
      content: '',
      wordCount: 0,
    });
    expect(contentModel.updateOne).toHaveBeenCalledWith(
      { _id: doc.contentId, deleted: false },
      {
        $set: { content: '', contentLength: 0, contentSummary: '' },
        $inc: { version: 1 },
      },
    );
  });

  it('rejects updating missing content before saving metadata', async () => {
    contentModel.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(service.update(id, { content: 'Changed' })).rejects.toThrow(
      BadRequestException,
    );
    expect(em.save).not.toHaveBeenCalled();
  });

  it('updates a summary without replacing content or incrementing its version', async () => {
    await expect(
      service.update(id, { summary: 'New summary' }),
    ).resolves.toMatchObject({
      summary: 'New summary',
      content: 'Original content',
    });
    expect(contentModel.updateOne).toHaveBeenCalledWith(
      { _id: doc.contentId, deleted: false },
      { $set: { contentSummary: 'New summary' } },
    );
  });

  it('soft deletes both stores without physically deleting content', async () => {
    await expect(service.remove(id)).resolves.toEqual({ id, deleted: true });
    expect(em.save).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: true }),
    );
    expect(contentModel.updateOne).toHaveBeenCalledWith(
      { _id: doc.contentId },
      { $set: { deleted: true } },
    );
    expect(contentModel.deleteOne).not.toHaveBeenCalled();
  });
});
