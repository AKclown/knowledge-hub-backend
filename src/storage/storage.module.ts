import { Module } from '@nestjs/common';
import { RustfsService } from './rustfs.service';

@Module({
  providers: [RustfsService],
  exports: [RustfsService],
})
export class StorageModule {}
