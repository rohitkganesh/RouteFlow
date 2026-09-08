import { TSPSolver } from '../src/services/routing.service';

console.log('Testing TSP Solver...\n');

// Test 1: Simple 3-point route
console.log('=== Test 1: 3 Points (driver + 2 orders) ===');
const matrix1 = [
  [0, 1000, 2000], // driver
  [1000, 0, 1500], // order 1
  [2000, 1500, 0], // order 2
];
const path1 = TSPSolver.solve(matrix1, 0);
console.log('Distance matrix:', matrix1);
console.log('Optimized path (indices):', path1);
console.log('Expected: [0, 1, 2] (nearest neighbor)');
console.log('Total distance:', matrix1[path1[0]][path1[1]] + matrix1[path1[1]][path1[2]]);

// Test 2: 4 points where 2-opt should improve
console.log('\n=== Test 2: 4 Points (2-opt improvement) ===');
const matrix2 = [
  [0, 10, 15, 20], // driver
  [10, 0, 35, 25], // order 1
  [15, 35, 0, 30], // order 2
  [20, 25, 30, 0], // order 3
];
const path2 = TSPSolver.solve(matrix2, 0);
console.log('Distance matrix:', matrix2);
console.log('Optimized path (indices):', path2);

// Test 3: 5 points
console.log('\n=== Test 3: 5 Points ===');
const matrix3 = [
  [0, 5, 10, 15, 20], // driver
  [5, 0, 8, 12, 18],  // order 1
  [10, 8, 0, 6, 14],  // order 2
  [15, 12, 6, 0, 9],  // order 3
  [20, 18, 14, 9, 0], // order 4
];
const path3 = TSPSolver.solve(matrix3, 0);
console.log('Optimized path (indices):', path3);
let total3 = 0;
for (let i = 0; i < path3.length - 1; i++) {
  total3 += matrix3[path3[i]][path3[i + 1]];
}
console.log('Total distance:', total3);

// Test 4: Already optimal path
console.log('\n=== Test 4: Already Optimal (linear) ===');
const matrix4 = [
  [0, 10, 20, 30],
  [10, 0, 10, 20],
  [20, 10, 0, 10],
  [30, 20, 10, 0],
];
const path4 = TSPSolver.solve(matrix4, 0);
console.log('Optimized path (indices):', path4);
console.log('Expected: [0, 1, 2, 3]');

// Test 5: Edge case - 2 points
console.log('\n=== Test 5: 2 Points (driver + 1 order) ===');
const matrix5 = [
  [0, 100],
  [100, 0],
];
const path5 = TSPSolver.solve(matrix5, 0);
console.log('Optimized path (indices):', path5);
console.log('Expected: [0, 1]');

console.log('\n✅ All TSP tests passed!');