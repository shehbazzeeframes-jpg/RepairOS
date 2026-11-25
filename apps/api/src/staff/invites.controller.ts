import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { AcceptInviteResponse, InvitePreview } from '@repairos/contracts';
import { type AuthContext, CurrentAuth, MaybeAuth, OptionalAuth, SignedIn } from '../auth/auth-context';
import { InvitesService } from './invites.service';

/** Public invite page API (story §3). GET is rate limited per IP in app.factory.ts. */
@Controller('invites')
export class InvitesController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @OptionalAuth()
  @Get(':token')
  preview(@Param('token') token: string, @MaybeAuth() auth: AuthContext | null): Promise<InvitePreview> {
    return this.invites.preview(token, auth);
  }

  @SignedIn()
  @Post(':token/accept')
  @HttpCode(200)
  accept(@Param('token') token: string, @CurrentAuth() auth: AuthContext): Promise<AcceptInviteResponse> {
    return this.invites.accept(token, auth);
  }
}
