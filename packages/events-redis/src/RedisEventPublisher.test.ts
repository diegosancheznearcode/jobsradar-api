import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { SearchEvent } from "@diegosancheznearcode/contracts";
import { RedisEventPublisher, subscribeToSearch } from "./RedisEventPublisher.js";

// Integración contra Redis real (docker-compose up -d redis) — pub/sub no
// se presta a mockear de forma útil.

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const publisherConnection = new Redis(REDIS_URL);
const publisher = new RedisEventPublisher(publisherConnection);

const unsubscribers: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

afterAll(async () => {
  await publisherConnection.quit();
});

function waitForEvent(searchId: string): { events: SearchEvent[]; unsubscribe: () => void; ready: Promise<void> } {
  const events: SearchEvent[] = [];
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const unsubscribe = subscribeToSearch(REDIS_URL, searchId, (event) => {
    events.push(event);
    resolveReady();
  });
  return { events, unsubscribe, ready };
}

describe("RedisEventPublisher + subscribeToSearch", () => {
  it("un evento publicado llega al suscriptor del mismo searchId", async () => {
    const searchId = `test-${Date.now()}-a`;
    const { events, unsubscribe, ready } = waitForEvent(searchId);
    unsubscribers.push(unsubscribe);

    // Pequeño margen para que la SUBSCRIBE llegue a Redis antes del PUBLISH.
    await new Promise((r) => setTimeout(r, 300));
    await publisher.publish(searchId, { type: "progress", found: 1, target: 50, page: 1 });

    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))]);
    expect(events).toEqual([{ type: "progress", found: 1, target: 50, page: 1 }]);
  });

  it("un suscriptor de otro searchId no recibe el evento", async () => {
    const searchIdA = `test-${Date.now()}-b`;
    const searchIdB = `test-${Date.now()}-c`;
    const { events: eventsB, unsubscribe } = waitForEvent(searchIdB);
    unsubscribers.push(unsubscribe);

    await new Promise((r) => setTimeout(r, 300));
    await publisher.publish(searchIdA, { type: "done", total: 50, partial: 0 });
    await new Promise((r) => setTimeout(r, 200));

    expect(eventsB).toEqual([]);
  });

  it("desconectar un suscriptor no afecta a otro escuchando el mismo searchId", async () => {
    const searchId = `test-${Date.now()}-d`;
    const first = waitForEvent(searchId);
    const second = waitForEvent(searchId);
    unsubscribers.push(second.unsubscribe);

    await new Promise((r) => setTimeout(r, 300));
    first.unsubscribe(); // se desconecta antes de que llegue nada

    await publisher.publish(searchId, { type: "error", message: "algo falló" });
    await Promise.race([second.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))]);

    expect(second.events).toEqual([{ type: "error", message: "algo falló" }]);
  });
});
