import { Redis } from "ioredis";
import type { SearchEvent } from "@jobsradar/contracts";
import { SearchEventSchema } from "@jobsradar/contracts";
import type { EventPublisherPort } from "@jobsradar/domain";

// Implementa EventPublisherPort — ver ARCHITECTURE.md sección 5. Redis
// pub/sub (AD-06 ya usa Redis para BullMQ) conecta al worker (publish) con
// el SSE de la API (subscribeToSearch) — decisión de Fase 6, el documento
// no definía el transporte entre procesos.

export function channelForSearch(searchId: string): string {
  return `search:${searchId}:events`;
}

export class RedisEventPublisher implements EventPublisherPort {
  constructor(private readonly redis: Redis) {}

  async publish(searchId: string, event: SearchEvent): Promise<void> {
    await this.redis.publish(channelForSearch(searchId), JSON.stringify(event));
  }
}

// No es parte de EventPublisherPort (el documento solo define publish) —
// es lo que usa apps/api para GET /api/searches/:id/stream. Cada llamada
// abre su propia conexión de suscripción (una por cliente SSE), así
// desconectar a uno nunca corta a otro que esté escuchando el mismo
// searchId.
export function subscribeToSearch(
  redisUrl: string,
  searchId: string,
  onEvent: (event: SearchEvent) => void,
): () => void {
  const subscriber = new Redis(redisUrl);
  const channel = channelForSearch(searchId);

  void subscriber.subscribe(channel);
  subscriber.on("message", (receivedChannel, message) => {
    if (receivedChannel !== channel) return;
    try {
      onEvent(SearchEventSchema.parse(JSON.parse(message)));
    } catch {
      // Mensaje mal formado — se ignora, no debería tirar el stream SSE completo.
    }
  });

  return () => {
    subscriber.disconnect();
  };
}
