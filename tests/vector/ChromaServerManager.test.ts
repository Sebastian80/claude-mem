import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ChromaServerManager } from '../../src/services/vector/ChromaServerManager.js';

// Port 1 is privileged (requires root), so chroma exits immediately
// with "Address 127.0.0.1:1 is not available", giving us a fast failure.
const FAIL_PORT = 1;

describe('ChromaServerManager', () => {
  describe('constructor', () => {
    it('should use default port 8100', () => {
      const manager = new ChromaServerManager();
      expect(manager.getPort()).toBe(8100);
    });

    it('should accept custom port', () => {
      const manager = new ChromaServerManager(9999);
      expect(manager.getPort()).toBe(9999);
    });

    it('should accept custom data directory', () => {
      const manager = new ChromaServerManager(8100, '/tmp/test-chroma');
      expect(manager.getPort()).toBe(8100);
    });
  });

  describe('initial state', () => {
    it('should not be healthy initially', () => {
      const manager = new ChromaServerManager(8100);
      expect(manager.isHealthy()).toBe(false);
    });

    it('should return correct URL', () => {
      const manager = new ChromaServerManager(8100);
      expect(manager.getUrl()).toBe('http://127.0.0.1:8100');
    });

    it('should return correct URL with custom port', () => {
      const manager = new ChromaServerManager(9999);
      expect(manager.getUrl()).toBe('http://127.0.0.1:9999');
    });
  });

  describe('heartbeat', () => {
    it('should return false when no server is running', async () => {
      // Use an unlikely port to ensure no server is there
      const manager = new ChromaServerManager(59999);
      const result = await manager.heartbeat();
      expect(result).toBe(false);
    });
  });

  describe('start with unavailable port', () => {
    it('should handle failed start gracefully', async () => {
      // Port 1 requires root — chroma exits immediately
      const manager = new ChromaServerManager(FAIL_PORT, '/tmp/chroma-test-fail');

      // start() should not throw even when the server can't bind
      await manager.start();

      // After a failed start, the manager should not be healthy
      expect(manager.isHealthy()).toBe(false);

      await manager.stop();
    }, 15_000);
  });

  describe('stop', () => {
    it('should be safe to call stop on a never-started manager', async () => {
      const manager = new ChromaServerManager(8100);
      // Should not throw
      await manager.stop();
      expect(manager.isHealthy()).toBe(false);
    });

    it('should be safe to call stop multiple times', async () => {
      const manager = new ChromaServerManager(8100);
      await manager.stop();
      await manager.stop();
      expect(manager.isHealthy()).toBe(false);
    });
  });
});

describe('ChromaServerManager circuit breaker', () => {
  it('should open circuit after 3 consecutive failures', async () => {
    // Port 1 requires root — each start attempt fails immediately
    const manager = new ChromaServerManager(FAIL_PORT, '/tmp/chroma-cb-test');

    // Each start attempt fails (can't bind to privileged port)
    // After 3 failures, circuit breaker opens
    await manager.start(); // failure 1
    expect(manager.isHealthy()).toBe(false);

    await manager.start(); // failure 2
    expect(manager.isHealthy()).toBe(false);

    await manager.start(); // failure 3 → circuit opens
    expect(manager.isHealthy()).toBe(false);

    // After circuit opens, start() should return immediately without attempting
    await manager.start(); // should be a no-op
    expect(manager.isHealthy()).toBe(false);

    await manager.stop();
  }, 30_000);
});
