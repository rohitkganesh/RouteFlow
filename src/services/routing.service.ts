import { config } from '../config/env.js';
import { Order } from '../models/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { haversineMeters } from '../utils/geo.js';

/**
 * Multiplier applied to haversine (straight-line) distance in mock mode to
 * approximate road-network distance. Roads don't follow straight lines, so
 * real road distance is typically ~1.25× the great-circle distance in
 * urban/suburban areas. The mock provider uses this so that offline
 * distances are realistic rather than straight-line.
 */
const ROAD_DISTANCE_FACTOR = config.ROUTING_ROAD_DISTANCE_FACTOR;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface RouteLeg {
  from: Coordinates;
  to: Coordinates;
  distance: number; // meters
  duration: number; // seconds
  polyline: string;
}

export interface OptimizedRoute {
  sequence: string[]; // order IDs in optimized delivery order
  legs: RouteLeg[];
  totalDistance: number; // meters
  totalDuration: number; // seconds
  encodedPolyline: string;
  routeIds?: string[];
  /**
   * Number of stops the driver makes for orders (pickup + delivery per
   * order). Always 2 × sequence.length for PDP routes; undefined for
   * legacy single-point TSP routes.
   */
  totalStops?: number;
  /**
   * Order IDs in the order their pickups are visited. Always the same
   * length as `sequence`; only set for PDP routes.
   */
  pickupSequence?: string[];
  /**
   * Per-order pickup→delivery leg in the same order as `sequence`.
   * Useful for callers that want a per-order cost without re-walking
   * the full stop list. Only set for PDP routes.
   */
  orderLegs?: RouteLeg[];
}

export interface DistanceMatrixResult {
  distances: number[][]; // meters
  durations: number[][]; // seconds
}

interface RoutingProvider {
  getDistanceMatrix(origins: Coordinates[], destinations: Coordinates[]): Promise<DistanceMatrixResult>;
  getRoute(origin: Coordinates, destination: Coordinates): Promise<RouteLeg>;
}

/**
 * Mock routing provider for testing without API calls
 */
export class MockRoutingProvider implements RoutingProvider {
  private delayMs: number;

  constructor(delayMs: number = config.ROUTING_MOCK_DELAY_MS) {
    this.delayMs = delayMs;
  }

  private async mockDelay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, this.delayMs));
  }

  /**
   * Road distance in meters. Starts from haversine (great-circle) distance
   * and applies {@link ROAD_DISTANCE_FACTOR} so the result approximates the
   * actual road-network distance rather than the straight-line distance.
   * The OSRM and Google providers return real road distances from their
   * APIs; this factor is only applied when the mock provider is active.
   */
  private roadDistance(from: Coordinates, to: Coordinates): number {
    const straight = haversineMeters(from, to) ?? 0;
    return straight * ROAD_DISTANCE_FACTOR;
  }

  private encodePolyline(coords: Coordinates[]): string {
    // Simplified polyline encoding for mock
    // Coerce to number first — pg returns DECIMAL columns as strings, which would crash .toFixed
    return coords
      .map(c => `${Number(c.latitude).toFixed(6)},${Number(c.longitude).toFixed(6)}`)
      .join(';');
  }

  async getDistanceMatrix(
    origins: Coordinates[],
    destinations: Coordinates[]
  ): Promise<DistanceMatrixResult> {
    await this.mockDelay();

    const distances: number[][] = [];
    const durations: number[][] = [];

    for (const origin of origins) {
      const distRow: number[] = [];
      const durRow: number[] = [];
      for (const dest of destinations) {
        const dist = this.roadDistance(origin, dest);
        // Assume average urban speed of 30 km/h = 8.33 m/s for the ETA.
        // Road distance is longer than straight-line, so the ETA
        // derived from it is proportionally longer — matching what a
        // real driver would experience on actual streets.
        const duration = dist / 8.33;
        distRow.push(Math.round(dist));
        durRow.push(Math.round(duration));
      }
      distances.push(distRow);
      durations.push(durRow);
    }

    return { distances, durations };
  }

  async getRoute(origin: Coordinates, destination: Coordinates): Promise<RouteLeg> {
    await this.mockDelay();

    const distance = this.roadDistance(origin, destination);
    const duration = distance / 8.33;

    return {
      from: origin,
      to: destination,
      distance: Math.round(distance),
      duration: Math.round(duration),
      polyline: this.encodePolyline([origin, destination]),
    };
  }
}

/**
 * OSRM routing provider (OpenStreetMap Routing Machine)
 */
class OSRMRoutingProvider implements RoutingProvider {
  private baseUrl: string;

  constructor(baseUrl: string = config.OSRM_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OSRM request failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  private coordsToString(coords: Coordinates): string {
    return `${coords.longitude},${coords.latitude}`;
  }

  async getDistanceMatrix(
    origins: Coordinates[],
    destinations: Coordinates[]
  ): Promise<DistanceMatrixResult> {
    // OSRM table service for distance matrix
    const allCoords = [...origins, ...destinations].map(this.coordsToString).join(';');
    const sources = origins.map((_, i) => i).join(';');
    const destinationsIdx = destinations.map((_, i) => origins.length + i).join(';');

    const url = `${this.baseUrl}/table/v1/driving/${allCoords}?sources=${sources}&destinations=${destinationsIdx}&annotations=distance,duration`;

    const result = await this.fetchJson<{
      distances: number[][];
      durations: number[][];
    }>(url);

    return {
      distances: result.distances,
      durations: result.durations,
    };
  }

  async getRoute(origin: Coordinates, destination: Coordinates): Promise<RouteLeg> {
    const url = `${this.baseUrl}/route/v1/driving/${this.coordsToString(origin)};${this.coordsToString(destination)}?overview=full&geometries=polyline`;

    const result = await this.fetchJson<{
      routes: Array<{
        distance: number;
        duration: number;
        geometry: string;
      }>;
    }>(url);

    if (!result.routes || result.routes.length === 0) {
      throw new Error('No route found');
    }

    const route = result.routes[0];
    return {
      from: origin,
      to: destination,
      distance: Math.round(route.distance),
      duration: Math.round(route.duration),
      polyline: route.geometry,
    };
  }
}

/**
 * Google Maps Distance Matrix & Directions API provider
 */
class GoogleMapsRoutingProvider implements RoutingProvider {
  private apiKey: string;

  constructor(apiKey: string = config.GOOGLE_MAPS_API_KEY || '') {
    this.apiKey = apiKey;
  }

  private coordsToString(coords: Coordinates): string {
    return `${coords.latitude},${coords.longitude}`;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Maps request failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  async getDistanceMatrix(
    origins: Coordinates[],
    destinations: Coordinates[]
  ): Promise<DistanceMatrixResult> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key not configured');
    }

    const originStr = origins.map(this.coordsToString).join('|');
    const destStr = destinations.map(this.coordsToString).join('|');

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
      originStr
    )}&destinations=${encodeURIComponent(destStr)}&mode=driving&key=${this.apiKey}`;

    const result = await this.fetchJson<{
      rows: Array<{
        elements: Array<{
          distance: { value: number };
          duration: { value: number };
          status: string;
        }>;
      }>;
      status: string;
    }>(url);

    if (result.status !== 'OK') {
      throw new Error(`Google Maps Distance Matrix error: ${result.status}`);
    }

    const distances: number[][] = [];
    const durations: number[][] = [];

    for (const row of result.rows) {
      const distRow: number[] = [];
      const durRow: number[] = [];
      for (const element of row.elements) {
        if (element.status === 'OK') {
          distRow.push(element.distance.value);
          durRow.push(element.duration.value);
        } else {
          distRow.push(0);
          durRow.push(0);
        }
      }
      distances.push(distRow);
      durations.push(durRow);
    }

    return { distances, durations };
  }

  async getRoute(origin: Coordinates, destination: Coordinates): Promise<RouteLeg> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key not configured');
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
      this.coordsToString(origin)
    )}&destination=${encodeURIComponent(this.coordsToString(destination))}&mode=driving&key=${this.apiKey}`;

    const result = await this.fetchJson<{
      routes: Array<{
        legs: Array<{
          distance: { value: number };
          duration: { value: number };
          polyline: { points: string };
        }>;
      }>;
      status: string;
    }>(url);

    if (result.status !== 'OK' || !result.routes || result.routes.length === 0) {
      throw new Error(`Google Maps Directions error: ${result.status}`);
    }

    const leg = result.routes[0].legs[0];
    return {
      from: origin,
      to: destination,
      distance: leg.distance.value,
      duration: leg.duration.value,
      polyline: leg.polyline.points,
    };
  }
}

/**
 * Factory to create the appropriate routing provider
 */
function createRoutingProvider(): RoutingProvider {
  switch (config.ROUTING_PROVIDER) {
    case 'google':
      return new GoogleMapsRoutingProvider();
    case 'osrm':
      return new OSRMRoutingProvider();
    case 'mock':
    default:
      return new MockRoutingProvider();
  }
}

/**
 * Pickup-and-Delivery Traveling Salesperson Problem solver.
 *
 * Variant of {@link TSPSolver} that adds a precedence constraint: for
 * every order, the pickup index must come before its matching delivery
 * index in the path. Each order contributes two points to the matrix
 * (`pairs[i] = { pickup, delivery }`).
 *
 * The driver is implicit — the caller passes its matrix row/col as
 * `startIndex` and we keep it pinned at position 0 of the path.
 *
 * Algorithm:
 *   1. Nearest-Neighbor with precedence — at each step choose the
 *      nearest point from the unvisited-pickups set OR the
 *      available-deliveries set (those whose pickup was already
 *      visited). A 5% tie-breaker prefers pickups so we don't starve
 *      them.
 *   2. 2-opt with precedence check — a candidate reversal is only
 *      accepted if every pickup still precedes its delivery.
 *
 * Returns the optimized path (driver first, then a mix of pickups and
 * deliveries).
 */
export class PDTSPSolver {
  static solve(
    distanceMatrix: number[][],
    pairs: Array<{ pickup: number; delivery: number }>,
    startIndex: number = 0
  ): number[] {
    const n = distanceMatrix.length;
    if (n === 0) return [];
    if (n === 1) return [startIndex];

    const path = this.nearestNeighbor(distanceMatrix, pairs, startIndex);
    return this.twoOpt(path, distanceMatrix, pairs);
  }

  private static nearestNeighbor(
    distanceMatrix: number[][],
    pairs: Array<{ pickup: number; delivery: number }>,
    startIndex: number
  ): number[] {
    const n = distanceMatrix.length;
    const visited = new Set<number>([startIndex]);
    const path: number[] = [startIndex];

    // Pickup → delivery lookup
    const deliveryOf = new Map<number, number>();
    for (const { pickup, delivery } of pairs) {
      deliveryOf.set(pickup, delivery);
    }
    // Set of all pickup indices and all delivery indices
    const allPickups = new Set(pairs.map(p => p.pickup));

    let current = startIndex;
    while (visited.size < n) {
      const candidates: number[] = [];
      // The set of delivery indices, pre-computed so the unpaired-index
      // branch below is O(1) instead of O(pairs) per index.
      const allDeliveries = new Set(pairs.map(p => p.delivery));
      for (let i = 0; i < n; i++) {
        if (visited.has(i)) continue;
        if (i === startIndex) continue; // start node is already visited
        if (allPickups.has(i)) {
          // pickup — always visitable
          candidates.push(i);
        } else if (allDeliveries.has(i)) {
          // delivery — visitable only if its pickup was visited
          const pickupIdx = pairs.find(p => p.delivery === i)?.pickup;
          if (pickupIdx !== undefined && visited.has(pickupIdx)) {
            candidates.push(i);
          }
        } else {
          // Unpaired index: behave like standard TSP. This is what
          // happens when the caller invokes PDTSPSolver with an empty
          // `pairs` array, or when a downstream point isn't part of
          // any pickup/delivery pair. Previously these were silently
          // dropped from the path, which corrupted the matrix-driven
          // routing output.
          candidates.push(i);
        }
      }

      if (candidates.length === 0) break;

      // Find nearest candidate
      let nearest = candidates[0];
      let minDist = distanceMatrix[current][nearest];
      for (let i = 1; i < candidates.length; i++) {
        const c = candidates[i];
        const d = distanceMatrix[current][c];
        if (d < minDist) {
          minDist = d;
          nearest = c;
        }
      }

      // 5% tie-breaker: if a pickup is within 5% of the nearest distance,
      // prefer it (so the driver doesn't starve pickups by always
      // choosing the next available delivery).
      const pickupBias = minDist * 1.05;
      let bestPickup: number | null = null;
      let minPickupDist = Infinity;
      for (const c of candidates) {
        if (allPickups.has(c)) {
          const d = distanceMatrix[current][c];
          if (d <= pickupBias && d < minPickupDist) {
            minPickupDist = d;
            bestPickup = c;
          }
        }
      }
      if (bestPickup !== null && (!allPickups.has(nearest) || minPickupDist < minDist)) {
        nearest = bestPickup;
      }

      path.push(nearest);
      visited.add(nearest);
      current = nearest;
    }

    return path;
  }

  private static twoOpt(
    path: number[],
    distanceMatrix: number[][],
    pairs: Array<{ pickup: number; delivery: number }>
  ): number[] {
    // pickup → delivery map for precedence checks
    const pickupToDelivery = new Map<number, number>();
    for (const { pickup, delivery } of pairs) {
      pickupToDelivery.set(pickup, delivery);
    }

    let bestPath = [...path];
    let bestDistance = this.calculatePathDistance(bestPath, distanceMatrix);
    let improved = true;
    let iterations = 0;
    const maxIterations = 500;

    while (improved && iterations < maxIterations) {
      improved = false;
      iterations++;
      for (let i = 1; i < bestPath.length - 1; i++) {
        for (let k = i + 1; k < bestPath.length; k++) {
          const newPath = [
            ...bestPath.slice(0, i),
            ...bestPath.slice(i, k + 1).reverse(),
            ...bestPath.slice(k + 1),
          ];

          if (!this.respectsPrecedence(newPath, pickupToDelivery)) continue;

          const newDistance = this.calculatePathDistance(newPath, distanceMatrix);
          if (newDistance < bestDistance - 1e-6) {
            bestPath = newPath;
            bestDistance = newDistance;
            improved = true;
          }
        }
      }
    }

    return bestPath;
  }

  /**
   * For every pickup/delivery pair, the pickup index in `path` must be
   * less than the delivery index. Returns true if the path satisfies
   * all pickup-before-delivery constraints.
   */
  private static respectsPrecedence(
    path: number[],
    pickupToDelivery: Map<number, number>
  ): boolean {
    const position = new Map<number, number>();
    for (let i = 0; i < path.length; i++) {
      position.set(path[i], i);
    }
    for (const [pickup, delivery] of pickupToDelivery) {
      const pIdx = position.get(pickup);
      const dIdx = position.get(delivery);
      if (pIdx === undefined || dIdx === undefined) return false;
      if (pIdx >= dIdx) return false;
    }
    return true;
  }

  private static calculatePathDistance(path: number[], distanceMatrix: number[][]): number {
    let distance = 0;
    for (let i = 0; i < path.length - 1; i++) {
      distance += distanceMatrix[path[i]][path[i + 1]];
    }
    return distance;
  }
}

/**
 * Traveling Salesperson Problem solver using Nearest Neighbor heuristic
 * with 2-opt optimization for better routes
 */
export class TSPSolver {
  /**
   * Solve TSP using Nearest Neighbor + 2-opt improvement
   * @param distanceMatrix - Square matrix of distances between all points
   * @param startIndex - Index of the starting point (driver's location)
   * @returns Optimized order of indices to visit
   */
  static solve(distanceMatrix: number[][], startIndex: number = 0): number[] {
    const n = distanceMatrix.length;
    if (n <= 2) return Array.from({ length: n }, (_, i) => i);

    // Step 1: Nearest Neighbor heuristic
    let path = this.nearestNeighbor(distanceMatrix, startIndex);

    // Step 2: 2-opt improvement
    path = this.twoOpt(path, distanceMatrix);

    return path;
  }

  private static nearestNeighbor(distanceMatrix: number[][], startIndex: number): number[] {
    const n = distanceMatrix.length;
    const visited = new Set<number>();
    const path: number[] = [startIndex];
    visited.add(startIndex);

    let current = startIndex;
    while (path.length < n) {
      let nearest = -1;
      let minDist = Infinity;

      for (let i = 0; i < n; i++) {
        if (!visited.has(i) && distanceMatrix[current][i] < minDist) {
          minDist = distanceMatrix[current][i];
          nearest = i;
        }
      }

      if (nearest === -1) break;
      path.push(nearest);
      visited.add(nearest);
      current = nearest;
    }

    return path;
  }

  private static twoOpt(path: number[], distanceMatrix: number[][]): number[] {
    let bestPath = [...path];
    let bestDistance = this.calculatePathDistance(bestPath, distanceMatrix);
    let improved = true;

    while (improved) {
      improved = false;
      // The outer loop starts at 1 (NOT 0) so the start node — the
      // driver's location at index 0 — is never moved from its
      // pinned position at the front of the path. A reversal that
      // started at index 0 would also reverse the start node.
      for (let i = 1; i < bestPath.length - 2; i++) {
        for (let k = i + 1; k < bestPath.length; k++) {
          const newPath = [
            ...bestPath.slice(0, i),
            ...bestPath.slice(i, k + 1).reverse(),
            ...bestPath.slice(k + 1),
          ];

          const newDistance = this.calculatePathDistance(newPath, distanceMatrix);
          if (newDistance < bestDistance) {
            bestPath = newPath;
            bestDistance = newDistance;
            improved = true;
          }
        }
      }
    }

    return bestPath;
  }

  private static calculatePathDistance(path: number[], distanceMatrix: number[][]): number {
    let distance = 0;
    for (let i = 0; i < path.length - 1; i++) {
      distance += distanceMatrix[path[i]][path[i + 1]];
    }
    return distance;
  }
}

/**
 * Main Routing Service
 */
export class RoutingService {
  private provider: RoutingProvider;

  constructor(provider?: RoutingProvider) {
    this.provider = provider || createRoutingProvider();
  }

  /**
   * Optimize delivery route for a driver with multiple orders
   * @param driverId - Driver's user ID
   * @param orderIds - Array of order IDs to deliver
   * @returns Optimized route with sequence, legs, and totals
   */
  async optimizeDeliveryRoute(driverId: string, orderIds: string[]): Promise<OptimizedRoute> {
    if (orderIds.length === 0) {
      throw new ValidationError('At least one order ID is required');
    }

    // Fetch driver's current location
    const driver = await this.getDriverLocation(driverId);
    if (!driver.current_latitude || !driver.current_longitude) {
      throw new ValidationError('Driver location not available');
    }

    // Fetch orders with coordinates
    const orders = await this.getOrdersByIds(orderIds);
    if (orders.length !== orderIds.length) {
      const foundIds = orders.map(o => o.id);
      const missing = orderIds.filter(id => !foundIds.includes(id));
      throw new NotFoundError(`Orders not found: ${missing.join(', ')}`);
    }

    // Build coordinates array: [driver, order1, order2, ...]
    const coordinates: Coordinates[] = [
      { latitude: driver.current_latitude, longitude: driver.current_longitude },
      ...orders.map(o => ({ latitude: o.latitude, longitude: o.longitude })),
    ];

    // Get distance matrix from routing provider
    const matrix = await this.provider.getDistanceMatrix(coordinates, coordinates);

    // Solve TSP: find optimal order to visit orders (starting from driver at index 0)
    // The path will be [0, orderIndex1, orderIndex2, ...] where indices are 1-based for orders
    const optimizedIndices = TSPSolver.solve(matrix.distances, 0);

    // Map indices back to order IDs (skip index 0 which is driver)
    const sequence = optimizedIndices
      .slice(1) // Remove driver start position
      .map(idx => orders[idx - 1].id); // Adjust for driver at index 0

    // Build route legs for the optimized sequence
    const legs: RouteLeg[] = [];
    let totalDistance = 0;
    let totalDuration = 0;
    const polylineSegments: string[] = [];

    // Leg from driver to first order
    let prevCoord = coordinates[0];
    for (const orderId of sequence) {
      const order = orders.find(o => o.id === orderId)!;
      const nextCoord = { latitude: order.latitude, longitude: order.longitude };

      const leg = await this.provider.getRoute(prevCoord, nextCoord);
      legs.push(leg);
      totalDistance += leg.distance;
      totalDuration += leg.duration;
      polylineSegments.push(leg.polyline);

      prevCoord = nextCoord;
    }

    // Combine polylines (simplified - in production you'd properly concatenate)
    const encodedPolyline = polylineSegments.join('|');

    return {
      sequence,
      legs,
      totalDistance,
      totalDuration,
      encodedPolyline,
    };
  }

  /**
   * Optimize delivery route using Pickup-and-Delivery TSP.
   *
   * Each order contributes a pickup point and a delivery point. The
   * solver guarantees every pickup is visited before its matching
   * delivery, so the route is physically valid.
   *
   * - Typed orders (with `pickup_latitude`/`pickup_longitude`/
   *   `delivery_latitude`/`delivery_longitude` columns) get real
   *   pickup+delivery coordinates.
   * - Legacy orders (only `latitude`/`longitude`) get a synthetic
   *   pickup = the driver's current location, which degenerates to
   *   standard TSP behavior.
   *
   * @returns OptimizedRoute with `sequence` (deliveries in order),
   *   `pickupSequence` (pickups in order), and `totalStops = 2N`.
   */
  async optimizeDeliveryRoutePDP(driverId: string, orderIds: string[]): Promise<OptimizedRoute> {
    if (orderIds.length === 0) {
      throw new ValidationError('At least one order ID is required');
    }

    // Fetch driver's current location
    const driver = await this.getDriverLocation(driverId);
    if (!driver.current_latitude || !driver.current_longitude) {
      throw new ValidationError('Driver location not available');
    }
    const driverCoord: Coordinates = {
      latitude: driver.current_latitude,
      longitude: driver.current_longitude,
    };

    // Fetch orders
    const orders = await this.getOrdersByIds(orderIds);
    if (orders.length !== orderIds.length) {
      const foundIds = orders.map(o => o.id);
      const missing = orderIds.filter(id => !foundIds.includes(id));
      throw new NotFoundError(`Orders not found: ${missing.join(', ')}`);
    }

    // Build coordinate list and pairs. For each order:
    //   - typed order with pickup coords: use real pickup + delivery
    //   - legacy order (no pickup coords): synthetic pickup = driver
    //     location (degenerates to TSP)
    const coordinates: Coordinates[] = [];
    const pairs: Array<{ pickup: number; delivery: number; orderId: string }> = [];

    for (const order of orders) {
      const deliveryCoord: Coordinates = {
        latitude: order.latitude,
        longitude: order.longitude,
      };
      const pickupCoord: Coordinates = this.getPickupCoord(order, driverCoord);

      pairs.push({
        pickup: coordinates.length,
        delivery: coordinates.length + 1,
        orderId: order.id,
      });
      coordinates.push(pickupCoord, deliveryCoord);
    }

    // Add the driver as the last point so we have a single square
    // matrix to feed to the solver. The driver isn't a real stop —
    // it's the start (and end) of the path. After solving we trim it
    // out of the leg list (no real route from "last delivery → driver"
    // is materialized as a leg in the response).
    const driverIdx = coordinates.length;
    coordinates.push(driverCoord);

    // Get distance matrix
    const matrix = await this.provider.getDistanceMatrix(coordinates, coordinates);

    // Solve PDP — the solver pins the driver at the start and returns
    // a path that visits all points, respecting pickup-before-delivery.
    const path = PDTSPSolver.solve(matrix.distances, pairs, driverIdx);

    // Map path back to per-order sequence. The result path includes
    // the driver at the start. We drop the driver index from the
    // returned legs.
    const stops = path.filter(idx => idx !== driverIdx);

    // Build legs in the visited order
    const legs: RouteLeg[] = [];
    let totalDistance = 0;
    let totalDuration = 0;
    const polylineSegments: string[] = [];
    let prevCoord = driverCoord;
    for (const idx of stops) {
      const nextCoord = coordinates[idx];
      const leg = await this.provider.getRoute(prevCoord, nextCoord);
      legs.push(leg);
      totalDistance += leg.distance;
      totalDuration += leg.duration;
      polylineSegments.push(leg.polyline);
      prevCoord = nextCoord;
    }

    // For each order, record which stop is its pickup and which is its
    // delivery. `sequence` is the order IDs in the order their
    // deliveries are visited; `pickupSequence` is the same for
    // pickups; `orderLegs` is the direct pickup→delivery leg for each
    // order (one routing call per order), in the same order as
    // `sequence`.
    const orderStopInfo = pairs.map(p => ({
      orderId: p.orderId,
      deliveryStopIdx: stops.indexOf(p.delivery),
      pickupStopIdx: stops.indexOf(p.pickup),
      pickupCoord: coordinates[p.pickup],
      deliveryCoord: coordinates[p.delivery],
    }));

    // Sort by delivery visit position → sequence
    const sequenceSorted = [...orderStopInfo].sort(
      (a, b) => a.deliveryStopIdx - b.deliveryStopIdx
    );
    // Sort by pickup visit position → pickupSequence
    const pickupSorted = [...orderStopInfo].sort(
      (a, b) => a.pickupStopIdx - b.pickupStopIdx
    );
    const sequence = sequenceSorted.map(o => o.orderId);
    const pickupSequence = pickupSorted.map(o => o.orderId);

    // Per-order pickup→delivery leg. Compute one routing call per
    // order. This is the business-meaningful per-order cost.
    const orderLegs: RouteLeg[] = [];
    for (const o of sequenceSorted) {
      const leg = await this.provider.getRoute(o.pickupCoord, o.deliveryCoord);
      orderLegs.push(leg);
    }

    const encodedPolyline = polylineSegments.join('|');

    return {
      sequence,
      legs,
      totalDistance,
      totalDuration,
      encodedPolyline,
      totalStops: stops.length,
      pickupSequence,
      orderLegs,
    };
  }

  /**
   * Extract the pickup coordinate for an order. Falls back to the
   * driver's current location for legacy orders that have no separate
   * pickup coords (degenerate case → behaves like standard TSP).
   *
   * The "0 means missing" check rejects BOTH columns being zero
   * simultaneously — that pair is the uninitialised sentinel. A real
   * pickup at (0°, 0°) (Gulf of Guinea) is rare but possible, so
   * don't blanket-reject either axis.
   */
  private getPickupCoord(order: Order, driverCoord: Coordinates): Coordinates {
    const typed = (order as Order & {
      pickup_latitude?: number | null;
      pickup_longitude?: number | null;
    });
    const pLat = Number(typed.pickup_latitude);
    const pLng = Number(typed.pickup_longitude);
    if (
      typed.pickup_latitude != null &&
      typed.pickup_longitude != null &&
      Number.isFinite(pLat) &&
      Number.isFinite(pLng) &&
      !(pLat === 0 && pLng === 0)
    ) {
      return { latitude: pLat, longitude: pLng };
    }
    // Legacy order: synthetic pickup = driver location
    return driverCoord;
  }

  /**
   * Get route between two points
   */
  async getRoute(origin: Coordinates, destination: Coordinates): Promise<RouteLeg> {
    return this.provider.getRoute(origin, destination);
  }

  /**
   * Get distance matrix between multiple points
   */
  async getDistanceMatrix(
    origins: Coordinates[],
    destinations: Coordinates[]
  ): Promise<DistanceMatrixResult> {
    return this.provider.getDistanceMatrix(origins, destinations);
  }

  /**
   * Switch routing provider (useful for testing)
   */
  setProvider(provider: RoutingProvider): void {
    this.provider = provider;
  }

  // Helper methods - in production these would use the actual database/services
  private async getDriverLocation(driverId: string): Promise<{
    current_latitude: number | null;
    current_longitude: number | null;
  }> {
    // Import dynamically to avoid circular dependency
    const { DriverService } = await import('./driver.service.js');
    const driver = await DriverService.getDriverById(driverId);
    if (!driver) {
      throw new NotFoundError('Driver not found');
    }
    return {
      current_latitude: driver.current_latitude ?? null,
      current_longitude: driver.current_longitude ?? null,
    };
  }

  private async getOrdersByIds(orderIds: string[]): Promise<Order[]> {
    const { OrderService } = await import('./order.service.js');
    const orders: Order[] = [];
    for (const id of orderIds) {
      const order = await OrderService.getOrderById(id);
      if (order) orders.push(order);
    }
    return orders;
  }
}

// Export singleton instance
export const routingService = new RoutingService();

// Re-export types
export type { RoutingProvider };