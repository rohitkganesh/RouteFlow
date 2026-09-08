/**
 * Smoke / regression tests for the MockRoutingProvider.
 *
 * Verifies that the mock provider:
 *   1. Produces distances that are road-distance = haversine × factor
 *      (not raw straight-line haversine).
 *   2. Produces durations consistent with 30 km/h over the *road* distance.
 *   3. Produces a valid polyline string in the mock `lat,lng;lat,lng` format.
 *   4. Handles multiple origins / destinations.
 *
 * Run:
 *   NODE_ENV=test npx tsx test/routing.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { config } from '../src/config/env';
import { haversineMeters } from '../src/utils/geo';
import { MockRoutingProvider } from '../src/services/routing.service';

let pass = 0;
let fail = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.error(`  ❌ ${msg}`);
  }
}

async function testRoutingService() {
  console.log('Testing Mock Routing Provider...\n');

  const provider = new MockRoutingProvider(0); // No delay for testing
  const roadFactor = config.ROUTING_ROAD_DISTANCE_FACTOR;

  // Test coordinates (sample locations in a city)
  const origin: { latitude: number; longitude: number } = { latitude: 40.7128, longitude: -74.0060 }; // NYC
  const dest1: { latitude: number; longitude: number } = { latitude: 40.7580, longitude: -73.9855 }; // Times Square
  const dest2: { latitude: number; longitude: number } = { latitude: 40.7484, longitude: -73.9857 }; // Empire State
  const dest3: { latitude: number; longitude: number } = { latitude: 40.7505, longitude: -73.9934 }; // Bryant Park

  // ============================================================
  // Test 1: Distance Matrix — road distance factor applied
  // ============================================================
  console.log('=== Test 1: Distance Matrix (road distance factor) ===');
  const matrix = await provider.getDistanceMatrix([origin], [dest1, dest2, dest3]);
  const hv01 = haversineMeters(origin, dest1) ?? 0;
  const hv02 = haversineMeters(origin, dest2) ?? 0;
  const hv03 = haversineMeters(origin, dest3) ?? 0;

  assert(
    Math.abs(matrix.distances[0][0] - hv01 * roadFactor) < 1,
    `matrix dist[0][0] ≈ haversine × ${roadFactor} (got ${matrix.distances[0][0]} m, straight-line ${hv01.toFixed(0)} m)`
  );
  assert(
    Math.abs(matrix.distances[0][1] - hv02 * roadFactor) < 1,
    `matrix dist[0][1] ≈ haversine × ${roadFactor} (got ${matrix.distances[0][1]} m, straight-line ${hv02.toFixed(0)} m)`
  );
  assert(
    Math.abs(matrix.distances[0][2] - hv03 * roadFactor) < 1,
    `matrix dist[0][2] ≈ haversine × ${roadFactor} (got ${matrix.distances[0][2]} m, straight-line ${hv03.toFixed(0)} m)`
  );
  console.log('Distances (meters):', matrix.distances[0].map(d => Math.round(d)));
  console.log('Straight-line (meters):', [hv01, hv02, hv03].map(d => Math.round(d)));
  console.log('Durations (seconds):', matrix.durations[0].map(d => Math.round(d)));

  // ============================================================
  // Test 2: Single Route — road distance + duration consistency
  // ============================================================
  console.log('\n=== Test 2: Single Route (road factor + ETA) ===');
  const route = await provider.getRoute(origin, dest1);
  const routeDist = Math.round(route.distance);
  const expectedDur = Math.round((hv01 * roadFactor) / 8.33);
  assert(
    routeDist > hv01,
    `road distance (${routeDist} m) > straight-line (${Math.round(hv01)} m)`
  );
  assert(
    Math.abs(route.distance - hv01 * roadFactor) < 1,
    `route distance ≈ haversine × ${roadFactor}`
  );
  assert(
    Math.abs(route.duration - expectedDur) < 1,
    `route duration ≈ road_distance / 8.33 (got ${route.duration} s, expected ~${expectedDur} s)`
  );
  console.log('Route:', {
    from: route.from,
    to: route.to,
    distance: routeDist + 'm',
    duration: Math.round(route.duration) + 's',
    polyline: route.polyline.substring(0, 50) + '...',
  });
  assert(route.polyline.includes(';'), 'polyline uses mock `lat,lng;lat,lng` format');
  assert(route.polyline.length > 0, 'polyline string non-empty');

  // ============================================================
  // Test 3: Multiple Origins
  // ============================================================
  console.log('\n=== Test 3: Multiple Origins ===');
  const multiMatrix = await provider.getDistanceMatrix([origin, dest1], [dest2, dest3]);
  console.log('Distance matrix:');
  multiMatrix.distances.forEach((row, i) => {
    console.log(`  Origin ${i}:`, row.map(d => Math.round(d) + 'm'));
  });
  // Row 0: origin→dest2, origin→dest3
  assert(
    Math.abs(multiMatrix.distances[0][0] - hv02 * roadFactor) < 1,
    `multiMatrix[0][0] ≈ haversine(origin→dest2) × ${roadFactor}`
  );
  // Row 1: dest1→dest2, dest1→dest3
  const hv12 = haversineMeters(dest1, dest2) ?? 0;
  const hv13 = haversineMeters(dest1, dest3) ?? 0;
  assert(
    Math.abs(multiMatrix.distances[0][0] - hv02 * roadFactor) < 1,
    `multiMatrix[0][0] matches origin→dest2 × factor`
  );
  assert(
    Math.abs(multiMatrix.distances[1][0] - hv12 * roadFactor) < 1,
    `multiMatrix[1][0] ≈ haversine(dest1→dest2) × ${roadFactor}`
  );
  assert(
    Math.abs(multiMatrix.distances[1][1] - hv13 * roadFactor) < 1,
    `multiMatrix[1][1] ≈ haversine(dest1→dest3) × ${roadFactor}`
  );

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n========================================');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('========================================');
  if (fail > 0) process.exit(1);
}

testRoutingService().catch(console.error);
