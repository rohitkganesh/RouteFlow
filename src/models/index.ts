export type UserRole = 'admin' | 'seller' | 'driver';
export type OrderStatus = 'pending' | 'assigned' | 'picked_up' | 'on_the_way' | 'delivered' | 'cancelled';
export type DriverAvailability = 'available' | 'busy' | 'offline';
export type RouteStatus = 'planned' | 'active' | 'completed' | 'cancelled';
export type SellerStatus = 'active' | 'inactive' | 'suspended';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  profile_details: UserProfileDetails;
  created_at: Date;
}

export interface UserProfileDetails {
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: string;
  avatarUrl?: string;
  preferences?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
  profileDetails?: Partial<UserProfileDetails>;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JWTPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  iat?: number;
  exp?: number;
}

export interface Order {
  id: string;
  seller_id: string;
  driver_id?: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  delivery_address: string;
  latitude: number;
  longitude: number;
  parcel_details: OrderParcelDetails;
  status: OrderStatus;
  created_at: Date;
  updated_at: Date;
}

export interface OrderParcelDetails {
  weight?: number;
  dimensions?: { length: number; width: number; height: number };
  value?: number;
  fragile?: boolean;
  description?: string;
  [key: string]: unknown;
}

export interface CreateOrderInput {
  sellerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  deliveryAddress: string;
  latitude: number;
  longitude: number;
  parcelDetails?: Partial<OrderParcelDetails>;
}

export interface Driver {
  id: string;
  user_id: string;
  current_latitude?: number;
  current_longitude?: number;
  availability_status: DriverAvailability;
  current_workload: number;
  created_at: Date;
  updated_at: Date;
}

export interface UpdateDriverLocationInput {
  latitude: number;
  longitude: number;
}

export interface UpdateDriverAvailabilityInput {
  availabilityStatus: DriverAvailability;
}

export interface Route {
  id: string;
  order_id: string;
  driver_id: string;
  optimized_polyline: string;
  estimated_travel_time: number;
  estimated_distance: number;
  status: RouteStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateRouteInput {
  orderId: string;
  driverId: string;
  optimizedPolyline: string;
  estimatedTravelTime: number;
  estimatedDistance: number;
}

export interface OptimizedRouteResponse {
  sequence: string[];
  legs: Array<{
    from: { latitude: number; longitude: number };
    to: { latitude: number; longitude: number };
    distance: number;
    duration: number;
    polyline: string;
  }>;
  totalDistance: number;
  totalDuration: number;
  encodedPolyline: string;
  routeIds: string[];
  /**
   * Number of stops the driver makes for orders (pickup + delivery per
   * order). Set for PDP routes (= 2 × sequence.length).
   */
  totalStops?: number;
  /**
   * Order IDs in the order their pickups are visited. Set for PDP
   * routes; same length as `sequence`.
   */
  pickupSequence?: string[];
  /**
   * Per-order pickup→delivery leg in the same order as `sequence`.
   * Set for PDP routes. Useful for callers that want a per-order cost
   * without re-walking the full stop list.
   */
  orderLegs?: Array<{
    from: { latitude: number; longitude: number };
    to: { latitude: number; longitude: number };
    distance: number;
    duration: number;
    polyline: string;
  }>;
}

export interface OptimizeRouteInput {
  driverId: string;
  orderIds: string[];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================
// Seller model
// ============================================

export interface Seller {
  id: string;
  user_id: string;
  business_name: string | null;
  business_type: string | null;
  business_email: string | null;
  business_phone: string | null;
  business_address: string | null;
  tax_id: string | null;
  license_number: string | null;
  status: SellerStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSellerInput {
  userId: string;
  businessName?: string;
  businessType?: string;
  businessEmail?: string;
  businessPhone?: string;
  businessAddress?: string;
  taxId?: string;
  licenseNumber?: string;
}

export interface UpdateSellerInput {
  businessName?: string;
  businessType?: string;
  businessEmail?: string;
  businessPhone?: string;
  businessAddress?: string;
  taxId?: string;
  licenseNumber?: string;
}

// ============================================
// Vehicle model
// ============================================

export type VehicleType = 'motorcycle' | 'car' | 'van' | 'truck' | 'bicycle';

export interface Vehicle {
  id: string;
  seller_id: string;
  plate_number: string;
  type: VehicleType;
  brand: string;
  model: string;
  year: number;
  color: string | null;
  capacity_weight: number;
  capacity_volume: number;
  fuel_type: string | null;
  insurance_expiry: string | null;
  registration_expiry: string | null;
  gps_device_id: string | null;
  driver_id: string | null;
  status: 'active' | 'inactive' | 'maintenance';
  created_at: Date;
  updated_at: Date;
}

export interface CreateVehicleInput {
  sellerId: string;
  plateNumber: string;
  type: VehicleType;
  brand: string;
  model: string;
  year: number;
  color?: string;
  capacityWeight: number;
  capacityVolume: number;
  fuelType?: string;
  insuranceExpiry?: string;
  registrationExpiry?: string;
  gpsDeviceId?: string;
  driverId?: string;
}

export interface UpdateVehicleInput {
  plateNumber?: string;
  type?: VehicleType;
  brand?: string;
  model?: string;
  year?: number;
  color?: string;
  capacityWeight?: number;
  capacityVolume?: number;
  fuelType?: string;
  insuranceExpiry?: string;
  registrationExpiry?: string;
  gpsDeviceId?: string;
  driverId?: string;
  status?: 'active' | 'inactive' | 'maintenance';
}

// ============================================
// Address
// ============================================

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  landmark?: string;
  instructions?: string;
}

// ============================================
// OrderItem
// ============================================

export interface OrderItem {
  name: string;
  description?: string;
  sku?: string;
  quantity: number;
  weight: number;
  volume: number;
  unitPrice: number;
}

// ============================================
// PaymentMethod
// ============================================

export type PaymentMethod = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET' | 'COD';

// ============================================
// OrderStatus (typed enum - matches frontend)
// ============================================

export type OrderStatusTyped =
  | 'PENDING'
  | 'CONFIRMED'
  | 'ASSIGNED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'FAILED'
  | 'RETURNED';

// Mapping helper: typed enum <-> DB enum
export const ORDER_STATUS_MAP: Record<OrderStatusTyped, OrderStatus> = {
  PENDING:    'pending',
  CONFIRMED:  'pending',     // treat confirmed as still pending for DB
  ASSIGNED:   'assigned',
  PICKED_UP:  'picked_up',
  IN_TRANSIT: 'on_the_way',
  DELIVERED:  'delivered',
  CANCELLED:  'cancelled',
  FAILED:     'cancelled',   // treat failed as cancelled for DB
  RETURNED:   'cancelled',
};
export const REVERSE_ORDER_STATUS_MAP: Record<OrderStatus, OrderStatusTyped> = {
  pending:     'PENDING',
  assigned:    'ASSIGNED',
  picked_up:   'PICKED_UP',
  on_the_way:  'IN_TRANSIT',
  delivered:   'DELIVERED',
  cancelled:   'CANCELLED',
};

// ============================================
// Typed Order model
// ============================================

export interface OrderSellerContact {
  id: string;
  businessName: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  businessAddress: string | null;
}

export interface OrderTyped {
  id: string;
  sellerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  pickupAddress: Address;
  deliveryAddress: Address;
  pickupLat: number;
  pickupLng: number;
  deliveryLat: number;
  deliveryLng: number;
  items: OrderItem[];
  totalWeight: number;
  totalVolume: number;
  totalValue: number;
  deliveryFee: number;
  discount: number;
  tax: number;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: 'PENDING' | 'PAID' | 'REFUNDED' | 'FAILED';
  status: OrderStatusTyped;
  driverId: string | null;
  routeId: string | null;
  driver?: OrderDriverSummary | null;
  /**
   * Seller contact info. Populated on the server for drivers/admins
   * viewing an order; the owning seller can ignore this field and use
   * /sellers/me instead.
   */
  seller?: OrderSellerContact | null;
  instructions?: string | null;
  scheduledPickupAt?: string | null;
  scheduledDeliveryAt?: string | null;
  actualPickupAt?: string | null;
  actualDeliveryAt?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  failedReason?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrderDriverSummary {
  id: string;
  userId: string;
  user?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
  };
  vehicle?: {
    id: string;
    plateNumber: string;
    brand: string;
    model: string;
  } | null;
}

export interface CreateOrderTypedInput {
  sellerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  pickupAddress: Address;
  deliveryAddress: Address;
  pickupLat: number;
  pickupLng: number;
  deliveryLat: number;
  deliveryLng: number;
  items: OrderItem[];
  totalWeight: number;
  totalVolume: number;
  totalValue: number;
  deliveryFee?: number;
  discount?: number;
  tax?: number;
  paymentMethod: PaymentMethod;
  instructions?: string;
  scheduledPickupAt?: string;
  scheduledDeliveryAt?: string;
  metadata?: Record<string, unknown>;
}

// ============================================
// Typed Route model (with waypoints)
// ============================================

export interface LocationPoint {
  lat: number;
  lng: number;
  name?: string;
  address?: string;
  orderId?: string;
}

export interface RouteTyped {
  id: string;
  sellerId: string;
  name: string;
  description: string | null;
  startLocation: LocationPoint;
  endLocation: LocationPoint;
  waypoints: LocationPoint[];
  driverId: string | null;
  vehicleId: string | null;
  scheduledStartAt: string | null;
  /** Distance in KILOMETERS (already converted from the raw meters
   *  stored in the DB by `RouteTypedService.normalize`). */
  estimatedDistance: number;
  /** Duration in MINUTES (already converted from raw seconds). */
  estimatedDuration: number;
  status: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  orders: string[]; // order IDs attached to this route
  createdAt: string;
  updatedAt: string;
}

export interface CreateRouteTypedInput {
  sellerId: string;
  name: string;
  description?: string;
  startLocation: LocationPoint;
  endLocation: LocationPoint;
  waypoints?: LocationPoint[];
  driverId?: string;
  vehicleId?: string;
  scheduledStartAt?: string;
  orderIds?: string[];
}

// ============================================
// Task model — per-stop work items for drivers
// ============================================
//
// A Task is one stop on a route: either PICKUP the parcel from the
// seller or DELIVERY to the customer. The frontend's TaskStatus
// enum is intentionally granular so the driver can show
// en-route / arrived states. TaskService.advanceStatus maps task
// transitions to the legacy `orders.status` enum so existing
// dashboards keep working.

export type TaskType = 'PICKUP' | 'DELIVERY';

export type TaskStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'EN_ROUTE_TO_PICKUP'
  | 'ARRIVED_AT_PICKUP'
  | 'PICKED_UP'
  | 'EN_ROUTE_TO_DROPOFF'
  | 'ARRIVED_AT_DROPOFF'
  | 'DELIVERED'
  | 'FAILED'
  | 'CANCELLED';

export interface Task {
  id: string;
  routeId: string | null;
  orderId: string;
  driverId: string;
  type: TaskType;
  status: TaskStatus;
  sequenceIndex: number;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  pickupAddress: Record<string, unknown>;
  deliveryAddress: Record<string, unknown>;
  estimatedPickupAt: string | null;
  estimatedDeliveryAt: string | null;
  actualPickupAt: string | null;
  actualDeliveryAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  routeId?: string | null;
  orderId: string;
  driverId: string;
  type: TaskType;
  sequenceIndex?: number;
  pickupLatitude?: number | null;
  pickupLongitude?: number | null;
  deliveryLatitude?: number | null;
  deliveryLongitude?: number | null;
  pickupAddress?: Record<string, unknown>;
  deliveryAddress?: Record<string, unknown>;
  estimatedPickupAt?: string | null;
  estimatedDeliveryAt?: string | null;
}