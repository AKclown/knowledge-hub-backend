import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { getEntityManagerToken } from '@nestjs/typeorm';
import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { Server } from 'http';
import * as request from 'supertest';
import { RustfsService } from '../src/storage/rustfs.service';
import { DocumentController } from '../src/document/document.controller';
import { DocumentService } from '../src/document/document.service';
import {
  DocumentEntity,
  DocumentStatus,
} from '../src/document/entities/document.entity';
import { FileParserService } from '../src/document/parser/file-parser.service';
import { DocumentContent } from '../src/document/schemas/document-content.schema';

void describe('DocumentService persistence', () => {
  let app: INestApplication<Server>;
  let service: DocumentService;
  const content = '# Lesson\n\nReading methods and examples.';
  const summary = '# Lesson Reading methods and examples.';
  const em = {
    create: mock.fn((_entity: unknown, data: Partial<DocumentEntity>) => data),
    save: mock.fn((data: Partial<DocumentEntity>) => Promise.resolve(data)),
    findOne: mock.fn(() =>
      Promise.resolve({
        id: '100',
        contentId: 'mongo-content-id',
        summary: 'Old summary',
      }),
    ),
  };
  const contentModel = {
    create: mock.fn((data: Record<string, unknown>) =>
      Promise.resolve({ ...data, _id: 'mongo-content-id' }),
    ),
    updateOne: mock.fn<
      (filter: unknown, update: unknown) => Promise<{ matchedCount: number }>
    >(() => Promise.resolve({ matchedCount: 1 })),
    deleteOne: mock.fn<(filter: unknown) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };
  const parser = {
    isSupported: () => true,
    parse: mock.fn(() => Promise.resolve(content)),
  };

  before(async () => {
    const module = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        DocumentService,
        { provide: getEntityManagerToken(), useValue: em },
        {
          provide: getModelToken(DocumentContent.name),
          useValue: contentModel,
        },
        { provide: FileParserService, useValue: parser },
        { provide: RustfsService, useValue: { isEnabled: () => false } },
      ],
    }).compile();

    service = module.get(DocumentService);
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    em.create.mock.resetCalls();
    em.save.mock.resetCalls();
    contentModel.create.mock.resetCalls();
    contentModel.updateOne.mock.resetCalls();
    contentModel.deleteOne.mock.resetCalls();
    parser.parse.mock.resetCalls();
  });

  after(async () => {
    await app?.close();
  });

  void it('stores the generated summary in both databases', async () => {
    const saved = await service.create({ title: 'Lesson', content });

    assert.equal(saved.summary, summary);
    assert.partialDeepStrictEqual(
      contentModel.create.mock.calls[0].arguments[0],
      { contentSummary: summary },
    );
    assert.partialDeepStrictEqual(em.create.mock.calls[0].arguments[1], {
      summary,
    });
  });

  void it('removes the Mongo content if the Postgres save fails', async () => {
    const error = new Error('Postgres unavailable');
    em.save.mock.mockImplementationOnce(() => Promise.reject(error));

    await assert.rejects(service.create({ title: 'Lesson', content }), error);
    assert.deepEqual(contentModel.deleteOne.mock.calls[0].arguments[0], {
      _id: 'mongo-content-id',
    });
  });

  void it('updates both summaries when the content changes without a summary', async () => {
    const saved = await service.update('100', { content });

    assert.equal(saved.summary, summary);
    assert.partialDeepStrictEqual(
      contentModel.updateOne.mock.calls[0].arguments[1],
      {
        $set: { contentSummary: summary },
      },
    );
  });

  void it('accepts and persists all upload metadata through the HTTP endpoint', async () => {
    await request(app.getHttpServer())
      .post('/documents/upload/parse')
      .field('summary', 'Custom summary')
      .field('categoryId', '20001')
      .field('teamId', '30001')
      .field('authorId', '10001')
      .field('createBy', '10001')
      .field('coverImage', '/covers/lesson.png')
      .field('tags', 'lesson,reading')
      .field('remark', 'Uploaded lesson')
      .field('isPublic', 'false')
      .attach('file', Buffer.from('file bytes'), 'lesson.pptx')
      .expect(201);

    assert.partialDeepStrictEqual(em.create.mock.calls[0].arguments[1], {
      title: 'lesson',
      summary: 'Custom summary',
      categoryId: '20001',
      teamId: '30001',
      authorId: '10001',
      createBy: '10001',
      updateBy: '10001',
      coverImage: '/covers/lesson.png',
      tags: 'lesson,reading',
      remark: 'Uploaded lesson',
      isPublic: false,
      status: DocumentStatus.Draft,
    });
    assert.partialDeepStrictEqual(
      contentModel.create.mock.calls[0].arguments[0],
      { contentSummary: 'Custom summary' },
    );
  });

  void it('generates an upload summary without inventing missing metadata', async () => {
    await request(app.getHttpServer())
      .post('/documents/upload/parse')
      .field('authorId', '10001')
      .field('createBy', '10001')
      .attach('file', Buffer.from('file bytes'), 'lesson.pptx')
      .expect(201);

    assert.partialDeepStrictEqual(em.create.mock.calls[0].arguments[1], {
      summary,
      categoryId: undefined,
      teamId: undefined,
      tags: undefined,
    });
  });

  void it('rejects invalid metadata before parsing or saving', async () => {
    await request(app.getHttpServer())
      .post('/documents/upload/parse')
      .field('isPublic', 'invalid')
      .attach('file', Buffer.from('file bytes'), 'lesson.pptx')
      .expect(400);

    assert.equal(parser.parse.mock.callCount(), 0);
    assert.equal(em.save.mock.callCount(), 0);
  });

  void it('does not save a document if parsing fails', async () => {
    parser.parse.mock.mockImplementationOnce(() =>
      Promise.reject(new Error('Invalid PPTX')),
    );

    await request(app.getHttpServer())
      .post('/documents/upload/parse')
      .attach('file', Buffer.from('invalid file'), 'lesson.pptx')
      .expect(400);

    assert.equal(contentModel.create.mock.callCount(), 0);
    assert.equal(em.save.mock.callCount(), 0);
  });
});
