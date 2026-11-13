import { Logger } from '@nestjs/common';

// Keep test output readable; failures still print via Jest.
Logger.overrideLogger(false);
