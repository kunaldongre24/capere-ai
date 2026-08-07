import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentUser, Roles } from '../auth';
import type { AuthenticatedUser } from '../auth/jwt-verifier.service';
import { CreateRagDocumentDto, ListRagDocumentsDto, type UploadedSourceFile } from './rag.dto';
import { RagService } from './rag.service';

@ApiTags('rag')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'rag/documents', version: '1' })
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentOrg() organizationId: string,
    @Query() query: ListRagDocumentsDto,
  ) {
    return this.rag.list({ userId: user.id, organizationId, query });
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentOrg() organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rag.get(user.id, organizationId, id);
  }

  @Post()
  @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin')
  @ApiConsumes('multipart/form-data')
  // Limits are configured centrally in RagModule from RAG_STORAGE_MAX_BYTES, so
  // Multer rejects oversized bodies while streaming and before full buffering.
  @UseInterceptors(FileInterceptor('file'))
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentOrg() organizationId: string,
    @UploadedFile() file: UploadedSourceFile,
    @Body() dto: CreateRagDocumentDto,
  ) {
    return this.rag.create({ userId: user.id, organizationId, dto, file });
  }
}
