import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './shared/database/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', service: 'nexora-backend', time: new Date().toISOString() };
  }

  @Public()
  @Get('health/db')
  async dbHealth() {
    try {
      await this.prisma.$queryRaw`select 1`;
      return { status: 'ok', database: 'connected' };
    } catch (err) {
      return { status: 'error', database: 'unreachable', message: (err as Error).message };
    }
  }
}
