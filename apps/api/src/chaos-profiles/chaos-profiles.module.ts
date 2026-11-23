import { Module } from '@nestjs/common';
import { ChaosProfilesController } from './chaos-profiles.controller';
import { ChaosProfilesService } from './chaos-profiles.service';

@Module({ controllers: [ChaosProfilesController], providers: [ChaosProfilesService], exports: [ChaosProfilesService] })
export class ChaosProfilesModule {}
