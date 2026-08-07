import { Global, Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { IntegrationModule } from '../integrations/integration.module';
import { CapabilityRouter } from './capability-router.service';
import { ContextBuilder } from './context/context-builder';
import { ToolExecutionService } from './execution/tool-execution.service';
import { GenerateChatResponseUseCase } from './generate-chat-response.use-case';
import { MemoryService } from './memory/memory.service';
import { PromptRegistryService } from './prompts/prompt-registry.service';
import { ResponseReviewService } from './review/response-review.service';
import { ToolRegistry } from './tools/tool-registry';
import { GetGa4SummaryTool } from './tools/get-ga4-summary.tool';
import { GetGscSummaryTool } from './tools/get-gsc-summary.tool';
import { GetGbpSummaryTool } from './tools/get-gbp-summary.tool';
import { GetSeoProjectSummaryTool } from './tools/get-seo-project-summary.tool';
import { GetGhlPipelineSummaryTool } from './tools/get-ghl-pipeline-summary.tool';

@Global()
@Module({
  imports: [RagModule, IntegrationModule],
  providers: [
    MemoryService,
    ContextBuilder,
    PromptRegistryService,
    ToolRegistry,
    GetGa4SummaryTool,
    GetGscSummaryTool,
    GetGbpSummaryTool,
    GetSeoProjectSummaryTool,
    GetGhlPipelineSummaryTool,
    ToolExecutionService,
    ResponseReviewService,
    CapabilityRouter,
    GenerateChatResponseUseCase,
  ],
  exports: [
    MemoryService,
    ContextBuilder,
    PromptRegistryService,
    ToolRegistry,
    ToolExecutionService,
    ResponseReviewService,
    CapabilityRouter,
    GenerateChatResponseUseCase,
  ],
})
export class IntelligenceModule {}
