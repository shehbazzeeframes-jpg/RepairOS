import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { CreateShopInput, type Shop } from '@repairos/contracts';
import { type AuthContext, CurrentAuth, SignedIn } from '../auth/auth-context';
import { ZodBody } from '../common/zod';
import { ShopsService } from './shops.service';

@Controller('shops')
export class ShopsController {
  constructor(@Inject(ShopsService) private readonly shops: ShopsService) {}

  /**
   * POST /api/shops: any signed-in user can create a shop and becomes its OWNER.
   * 403 SHOP_LIMIT_REACHED (owns 3), 429 RATE_LIMITED (5 per hour).
   */
  @SignedIn()
  @Post()
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @ZodBody(CreateShopInput) input: CreateShopInput): Promise<Shop> {
    return this.shops.create(auth, input);
  }
}
