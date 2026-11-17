import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Role } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { STAFF_ROLES } from '../common/decorators';

/**
 * Push channel for call signalling (incoming call, accepted, ended, queue changes).
 * Clients only LISTEN here; every action goes through the REST API so it is authorised,
 * validated and audited in one place. Audio/video itself travels through Agora, not here.
 *
 * Rooms: `user:<userId>` (every client) and `agents` (call-center staff).
 * Multi-server deployments need the Socket.IO Redis adapter (see README).
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket) {
    const token: string | undefined = client.handshake.auth?.token ?? (client.handshake.query?.token as string | undefined);
    try {
      if (!token) throw new Error('no token');
      const payload = await this.jwt.verifyAsync<{ sub: string; role: Role }>(token);
      client.data.user = payload;
      await client.join(`user:${payload.sub}`);
      if (STAFF_ROLES.includes(payload.role)) await client.join('agents');
    } catch {
      client.emit('auth:error', { message: 'Invalid or expired token' });
      client.disconnect(true);
    }
  }
}

@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  toUser(userId: string | null | undefined, event: string, payload: unknown) {
    if (userId) this.gateway.server?.to(`user:${userId}`).emit(event, payload);
  }

  toAgents(event: string, payload: unknown) {
    this.gateway.server?.to('agents').emit(event, payload);
  }
}

@Global()
@Module({ providers: [RealtimeGateway, RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
