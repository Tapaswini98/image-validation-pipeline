import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ImagesService } from './images.service';
import { ListImagesQuery, UploadImageBody, type ImageDto, type ImagePage } from './dto/images.dto';

@Controller('images')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  /**
   * One file per request (the client uploads in parallel with a concurrency limit).
   * vs. one 50-file multipart request: per-file progress bars, per-file retries, and one bad
   * file or dropped connection doesn't fail the whole batch.
   *
   * 202 Accepted: the file is stored and queued; poll GET /images?ids=... for the verdict.
   * Size/format failures come back immediately with status REJECTED.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadImageBody,
  ): Promise<ImageDto> {
    return this.images.ingest(file, body.collectionId);
  }

  @Get()
  list(@Query() query: ListImagesQuery): Promise<ImagePage> {
    return this.images.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ImageDto> {
    return this.images.get(id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Param('id', ParseUUIDPipe) id: string): Promise<ImageDto> {
    return this.images.retry(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.images.remove(id);
  }
}
