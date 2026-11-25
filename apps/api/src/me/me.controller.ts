import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { type MeResponse, SetActiveShopInput } from '@repairos/contracts';
import { type AuthContext, CurrentAuth } from '../auth/auth-context';
import { ZodBody } from '../common/zod';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(@Inject(MeService) private readonly me: MeService) {}

  /** GET /api/me: 401 when signed out; activeShop/role null until onboarding. */
  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.me.getMe(auth);
  }

  /** POST /api/me/active-shop: 403 when the user is not a member. Returns the updated MeResponse. */
  @Post('active-shop')
  @HttpCode(200)
  setActiveShop(
    @CurrentAuth() auth: AuthContext,
    @ZodBody(SetActiveShopInput) input: SetActiveShopInput,
  ): Promise<MeResponse> {
    return this.me.setActiveShop(auth, input.shopId);
  }
}
