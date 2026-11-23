import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { chaosProfileHash, chaosProfileSchema, type ChaosProfile } from '@dataforge/chaos';
import { idParam, positiveIntParam } from '../http/params';
import type { ChaosProfileSummaryView, ChaosProfileValidationView, ChaosProfileVersionView, ChaosProfileView } from './chaos-profile-views';
import { ChaosProfilesService } from './chaos-profiles.service';

/** The part of the HTTP response the versions endpoint sets: 201 for a new version, 200 for an existing one. */
interface StatusResponse {
  status(code: number): unknown;
}

@Controller('chaos-profiles')
export class ChaosProfilesController {
  constructor(private readonly profiles: ChaosProfilesService) {}

  /** The body is a chaos profile file, exactly as in chaos-profiles/; the chaos profile schema validates it. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body({ schema: chaosProfileSchema }) profile: ChaosProfile): Promise<ChaosProfileView> {
    return this.profiles.create(profile);
  }

  /**
   * A dry run of POST /chaos-profiles: the same schema and the same validation pipe, so an invalid profile gets
   * exactly the 400 the create endpoint gives (the loss rule included); a valid one is answered with its
   * resolved definition and hash, and nothing is stored.
   */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(@Body({ schema: chaosProfileSchema }) profile: ChaosProfile): ChaosProfileValidationView {
    return { valid: true, name: profile.name, profileHash: chaosProfileHash(profile), definition: profile };
  }

  @Get()
  async list(): Promise<{ chaosProfiles: ChaosProfileSummaryView[] }> {
    return { chaosProfiles: await this.profiles.list() };
  }

  @Get(':id')
  get(@Param('id', idParam('chaos profile')) id: string): Promise<ChaosProfileView> {
    return this.profiles.get(id);
  }

  @Post(':id/versions')
  async addVersion(
    @Param('id', idParam('chaos profile')) id: string,
    @Body({ schema: chaosProfileSchema }) profile: ChaosProfile,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<ChaosProfileVersionView> {
    const { created, version } = await this.profiles.addVersion(id, profile);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return version;
  }

  @Get(':id/versions/:version')
  getVersion(
    @Param('id', idParam('chaos profile')) id: string,
    @Param('version', positiveIntParam('version')) version: number,
  ): Promise<ChaosProfileVersionView> {
    return this.profiles.getVersion(id, version);
  }
}
