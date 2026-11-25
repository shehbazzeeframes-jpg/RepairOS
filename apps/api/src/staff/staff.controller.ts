import { Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  ChangeRoleInput,
  CreateInviteInput,
  type InviteLinkResponse,
  type StaffListItem,
  StaffListQuery,
  type StaffListResponse,
} from '@repairos/contracts';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { ZodBody, ZodQuery } from '../common/zod';
import { StaffService } from './staff.service';

/** Staff management and invites (story §2). Writes also check `canManageRole` in the service. */
@Controller('staff')
export class StaffController {
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}

  @RequirePermission('staff.view')
  @Get()
  list(@CurrentActor() actor: Actor, @ZodQuery(StaffListQuery) query: StaffListQuery): Promise<StaffListResponse> {
    return this.staff.list(actor, query.status);
  }

  @RequirePermission('staff.manage')
  @Post('invites')
  @HttpCode(201)
  invite(@CurrentActor() actor: Actor, @ZodBody(CreateInviteInput) input: CreateInviteInput): Promise<StaffListItem> {
    return this.staff.createInvite(actor, input);
  }

  @RequirePermission('staff.manage')
  @Post('invites/:id/resend')
  @HttpCode(200)
  resend(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<StaffListItem> {
    return this.staff.resendInvite(actor, id);
  }

  @RequirePermission('staff.manage')
  @Post('invites/:id/revoke')
  @HttpCode(204)
  async revoke(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<void> {
    await this.staff.revokeInvite(actor, id);
  }

  @RequirePermission('staff.manage')
  @Post('invites/:id/link')
  @HttpCode(200)
  link(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<InviteLinkResponse> {
    return this.staff.copyInviteLink(actor, id);
  }

  @RequirePermission('staff.manage')
  @Patch(':membershipId/role')
  changeRole(
    @CurrentActor() actor: Actor,
    @Param('membershipId') membershipId: string,
    @ZodBody(ChangeRoleInput) input: ChangeRoleInput,
  ): Promise<StaffListItem> {
    return this.staff.changeRole(actor, membershipId, input.role);
  }

  @RequirePermission('staff.manage')
  @Post(':membershipId/deactivate')
  @HttpCode(200)
  deactivate(@CurrentActor() actor: Actor, @Param('membershipId') membershipId: string): Promise<StaffListItem> {
    return this.staff.deactivate(actor, membershipId);
  }

  @RequirePermission('staff.manage')
  @Post(':membershipId/reactivate')
  @HttpCode(200)
  reactivate(@CurrentActor() actor: Actor, @Param('membershipId') membershipId: string): Promise<StaffListItem> {
    return this.staff.reactivate(actor, membershipId);
  }
}
