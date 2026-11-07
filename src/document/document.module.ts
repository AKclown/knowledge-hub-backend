import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentEntity } from './entities/document.entity';
import {
  DocumentContent,
  DocumentContentSchema,
} from './schemas/document-content.schema';
import { StorageModule } from '../storage/storage.module';
import { FileParserService } from './parser/file-parser.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentEntity]),
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    StorageModule,
  ],
  controllers: [DocumentController],
  providers: [DocumentService, FileParserService],
  exports: [DocumentService, FileParserService],
})
export class DocumentModule {}
