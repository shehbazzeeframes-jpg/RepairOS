import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { type MeResponse, SetActiveShopInput } from '@repairos/contracts';
import { AllowShopFallback, type AuthContext, CurrentAuth, SignedIn } from '../auth/auth-context';
import { ZodBody } from '../common/zod';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(@Inject(MeService) private readonly me: MeService) {}

  /**
   * GET /api/me: 401 when signed out; activeShop/role null until onboarding or when every membership is
   * deactivated (then `accessRemoved` is set). If the session's shop was deactivated, this is the request that
   * moves the session to another ACTIVE membership (banner shown once).
   */
  @SignedIn()
  @AllowShopFallback()
  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.me.getMe(auth);
  }

  /** POST /api/me/active-shop: 403 when the user is not an ACTIVE member. Returns the updated MeResponse. */
  @SignedIn()
  @Post('active-shop')
  @HttpCode(200)
  setActiveShop(
    @CurrentAuth() auth: AuthContext,
    @ZodBody(SetActiveShopInput) input: SetActiveShopInput,
  ): Promise<MeResponse> {
    return this.me.setActiveShop(auth, input.shopId);
  }
}
