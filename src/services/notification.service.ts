import { config } from '../config/env';
import { knex } from '../config/database';
import { Order, OrderStatus } from '../models';
import { User } from '../models';
import { emitNotification } from '../socket';

/**
 * Notification Service
 * Handles SMS (Twilio) and Email (Nodemailer) notifications for order status updates
 */

// Notification message templates
const NOTIFICATION_TEMPLATES: Record<OrderStatus, { sms: string; email: { subject: string; html: string } }> = {
  assigned: {
    sms: 'Your order #{orderId} has been assigned to a driver. Track it here: {trackingUrl}',
    email: {
      subject: 'Order #{orderId} Assigned - RouteFlow',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #3b82f6;">Order Assigned</h2>
          <p>Your order <strong>#{orderId}</strong> has been assigned to a driver.</p>
          <p><strong>Customer:</strong> {customerName}</p>
          <p><strong>Delivery Address:</strong> {deliveryAddress}</p>
          <p>You can track your order in real-time:</p>
          <p><a href="{trackingUrl}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Track Order</a></p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 14px;">RouteFlow - Logistics & Route Management</p>
        </div>
      `,
    },
  },
  picked_up: {
    sms: 'Your order #{orderId} has been picked up by the driver. Track it here: {trackingUrl}',
    email: {
      subject: 'Order #{orderId} Picked Up - RouteFlow',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">Order Picked Up</h2>
          <p>Your order <strong>#{orderId}</strong> has been picked up by the driver and is on its way.</p>
          <p><strong>Customer:</strong> {customerName}</p>
          <p><strong>Delivery Address:</strong> {deliveryAddress}</p>
          <p>Track your order in real-time:</p>
          <p><a href="{trackingUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Track Order</a></p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 14px;">RouteFlow - Logistics & Route Management</p>
        </div>
      `,
    },
  },
  on_the_way: {
    sms: 'Your order #{orderId} is on the way! Track it here: {trackingUrl}',
    email: {
      subject: 'Order #{orderId} In Transit - RouteFlow',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #f59e0b;">Order In Transit</h2>
          <p>Your order <strong>#{orderId}</strong> is currently in transit to the delivery address.</p>
          <p><strong>Customer:</strong> {customerName}</p>
          <p><strong>Delivery Address:</strong> {deliveryAddress}</p>
          <p>Track your order in real-time:</p>
          <p><a href="{trackingUrl}" style="background: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Track Order</a></p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 14px;">RouteFlow - Logistics & Route Management</p>
        </div>
      `,
    },
  },
  delivered: {
    sms: 'Hi {customerName}, your RouteFlow order #{orderId} has been successfully delivered! Thank you for using our service.',
    email: {
      subject: 'Your Order Has Been Delivered! #{orderId}',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">Order Delivered Successfully</h2>
          <p>Your order <strong>#{orderId}</strong> has been delivered successfully.</p>
          <p><strong>Customer:</strong> {customerName}</p>
          <p><strong>Item Summary:</strong> {itemSummary}</p>
          <p><strong>Delivery Address:</strong> {deliveryAddress}</p>
          <p>View delivery details:</p>
          <p><a href="{trackingUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Details</a></p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 14px;">RouteFlow - Logistics & Route Management</p>
        </div>
      `,
    },
  },
  cancelled: {
    sms: 'Your order #{orderId} has been cancelled. Details: {trackingUrl}',
    email: {
      subject: 'Order #{orderId} Cancelled - RouteFlow',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">Order Cancelled</h2>
          <p>Your order <strong>#{orderId}</strong> has been cancelled.</p>
          <p><strong>Customer:</strong> {customerName}</p>
          <p><strong>Delivery Address:</strong> {deliveryAddress}</p>
          <p>View details:</p>
          <p><a href="{trackingUrl}" style="background: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Details</a></p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 14px;">RouteFlow - Logistics & Route Management</p>
        </div>
      `,
    },
  },
  pending: {
    sms: 'Your order #{orderId} is pending. Track it here: {trackingUrl}',
    email: {
      subject: 'Order Confirmed - Track Your Delivery #{orderId}',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #3b82f6;">Order Confirmed</h2>
          <p>Your order <strong>#{orderId}</strong> has been placed and is being prepared for delivery.</p>
          <p><strong>Customer:</strong> {customerName}</p>
          <p><strong>Item Summary:</strong> {itemSummary}</p>
          <p><strong>Delivery Address:</strong> {deliveryAddress}</p>
          <p>Track your order in real-time:</p>
          <p><a href="{trackingUrl}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Track Your Order</a></p>
          <p style="color: #6b7280; font-size: 14px;">We'll email you again when your order is delivered.</p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 14px;">RouteFlow - Logistics & Route Management</p>
        </div>
      `,
    },
  },
};

interface NotificationPayload {
  order: Order;
  status: OrderStatus;
  customerPhone?: string;
  customerEmail?: string;
}

class NotificationService {
  private twilioClient: any = null;
  private emailTransporter: any = null;
  private initialized = false;

  /**
   * Initialize Twilio and Email clients
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize Twilio if credentials are available
    if (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN) {
      try {
        // Dynamic import to avoid issues if Twilio is not installed
        const twilio = await import('twilio');
        this.twilioClient = twilio.default(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
        console.log('✅ Twilio client initialized');
      } catch (error) {
        console.warn('⚠️ Twilio not available:', error);
      }
    }

    // Initialize Nodemailer if SMTP credentials are available.
    // The operator can set either `SMTP_USER` / `SMTP_PASSWORD`
    // (the canonical names) or `EMAIL_USER` / `EMAIL_PASS` (the
    // friendlier aliases added in the 2026-09-07 audit). The
    // SMTP_* names win when both are set, so legacy deployments
    // don't break.
    const smtpUser = config.SMTP_USER || config.EMAIL_USER;
    const smtpPass = config.SMTP_PASSWORD || config.EMAIL_PASS;
    if (config.SMTP_HOST && smtpUser && smtpPass) {
      try {
        const nodemailer = await import('nodemailer');
        this.emailTransporter = nodemailer.default.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_PORT === 465, // true for 465, false for other ports
          auth: {
            user: smtpUser,
            pass: smtpPass,
          },
        });
        // Verify connection
        await this.emailTransporter.verify();
        console.log('✅ Email transporter initialized');
      } catch (error) {
        console.warn('⚠️ Email transporter not available:', error);
      }
    }

    this.initialized = true;
  }

  /**
   * Build tracking URL for an order
   */
  private buildTrackingUrl(orderId: string): string {
    const baseUrl = config.PUBLIC_APP_URL.replace(/\/$/, '');
    return `${baseUrl}/track/${orderId}`;
  }

  /**
   * Get notification template for a status
   */
  private getTemplate(status: OrderStatus) {
    return NOTIFICATION_TEMPLATES[status] || NOTIFICATION_TEMPLATES.pending;
  }

  /**
   * Send SMS notification via Twilio
   */
  async sendSMS(to: string, message: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    await this.initialize();

    if (!this.twilioClient || !config.TWILIO_PHONE_NUMBER) {
      console.log('📱 SMS skipped (Twilio not configured):', { to, message: message.substring(0, 50) + '...' });
      return { success: false, error: 'Twilio not configured' };
    }

    try {
      const result = await this.twilioClient.messages.create({
        body: message,
        from: config.TWILIO_PHONE_NUMBER,
        to: to,
      });
      console.log('✅ SMS sent:', result.sid);
      return { success: true, messageId: result.sid };
    } catch (error: any) {
      console.error('❌ SMS failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send Email notification via Nodemailer
   */
  async sendEmail(to: string, subject: string, html: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    await this.initialize();

    if (!this.emailTransporter || !config.SMTP_FROM_EMAIL) {
      console.log('📧 Email skipped (SMTP not configured):', { to, subject });
      return { success: false, error: 'Email not configured' };
    }

    try {
      const result = await this.emailTransporter.sendMail({
        from: `"${config.SMTP_FROM_NAME || 'RouteFlow'}" <${config.SMTP_FROM_EMAIL}>`,
        to,
        subject,
        html,
      });
      console.log('✅ Email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error: any) {
      console.error('❌ Email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send order status notification to customer
   */
  async sendOrderStatusNotification(payload: NotificationPayload): Promise<void> {
    const { order, status, customerPhone, customerEmail } = payload;
    const template = this.getTemplate(status);
    const trackingUrl = this.buildTrackingUrl(order.id);
    const shortOrderId = order.id.substring(0, 8).toUpperCase();

    // Derive a one-line item summary from the encrypted
    // `parcel_details` blob. Description wins when present;
    // otherwise we fall back to "{weight}kg parcel"; otherwise
    // a generic "Parcel". The email body uses {itemSummary}.
    const parcel = (order as { parcel_details?: { description?: string; weight?: number } })
      .parcel_details;
    const itemSummary =
      parcel?.description?.trim() ||
      (parcel?.weight ? `${parcel.weight}kg parcel` : 'Parcel');

    // Prepare template variables
    const variables = {
      orderId: shortOrderId,
      customerName: order.customer_name,
      deliveryAddress: order.delivery_address,
      itemSummary,
      trackingUrl,
    };

    // Build messages
    const smsMessage = this.renderTemplate(template.sms, variables);
    const emailSubject = this.renderTemplate(template.email.subject, variables);
    const emailHtml = this.renderTemplate(template.email.html, variables);

    // Send SMS if phone number provided and Twilio configured
    if (customerPhone) {
      await this.sendSMS(customerPhone, smsMessage);
    }

    // Send Email if email provided and SMTP configured
    if (customerEmail) {
      await this.sendEmail(customerEmail, emailSubject, emailHtml);
    }
  }

  /**
   * Simple template rendering
   */
  private renderTemplate(template: string, variables: Record<string, string>): string {
    return template.replace(/{(\w+)}/g, (match, key) => variables[key] || match);
  }

  /**
   * Send notification for order status change (called from OrderService)
   */
  async notifyOrderStatusChange(order: Order, newStatus: OrderStatus): Promise<void> {
    // Only send notifications for customer-relevant status changes.
    // `pending` is included so OrderService.create can fire the
    // "Order Confirmed" email on creation. Without this entry, the
    // pending template is dead code and the customer never gets
    // their first email.
    const notificationStatuses: OrderStatus[] = [
      'pending',
      'assigned',
      'picked_up',
      'on_the_way',
      'delivered',
      'cancelled',
    ];

    if (!notificationStatuses.includes(newStatus)) {
      return;
    }

    await this.sendOrderStatusNotification({
      order,
      status: newStatus,
      customerPhone: order.customer_phone,
      customerEmail: order.customer_email ?? undefined,
    });

    // Mirror the event in the in-app inbox for the seller (who owns the
    // order). Drivers get their own channel via notifyDriverAssignment.
    if (order.seller_id) {
      const title = `Order ${shortId(order.id)} → ${statusLabel(newStatus)}`;
      const body = `Your order is now ${statusLabel(newStatus).toLowerCase()}.`;
      await this.notifyInApp(order.seller_id, 'order_status', title, body, {
        orderId: order.id,
        status: newStatus,
      });
    }
  }

  /**
   * Notify the driver that an order has been assigned to them.
   * Writes to the in-app inbox (always) and attempts an SMS/email if
   * the driver's contact info is on file and Twilio/SMTP are configured.
   */
  async notifyDriverAssignment(opts: {
    driverUserId: string;
    driverPhone?: string | null;
    driverEmail?: string | null;
    orderId: string;
    pickupAddress?: string;
  }): Promise<void> {
    const { driverUserId, driverPhone, driverEmail, orderId, pickupAddress } = opts;

    // 1. In-app notification — this is the source of truth in dev.
    await this.notifyInApp(
      driverUserId,
      'order_assigned',
      `New order ${shortId(orderId)}`,
      pickupAddress
        ? `Pickup at: ${pickupAddress}`
        : 'You have a new order. Open the driver app to view details.',
      { orderId }
    );

    // 2. SMS/email are best-effort. If credentials are not configured the
    //    sendSMS / sendEmail methods log and return { success: false } —
    //    that's expected in dev.
    if (driverPhone) {
      await this.sendSMS(
        driverPhone,
        `RouteFlow: New order ${shortId(orderId)} assigned. Open the app for details.`
      );
    }
    if (driverEmail) {
      await this.sendEmail(
        driverEmail,
        `New RouteFlow order ${shortId(orderId)}`,
        `<p>You have a new delivery: <strong>${shortId(orderId)}</strong></p>` +
          (pickupAddress ? `<p>Pickup: ${pickupAddress}</p>` : '') +
          `<p>Open the RouteFlow driver app to accept.</p>`
      );
    }
  }

  /**
   * Persist an in-app notification row for a user and emit the live
   * socket event so any open dashboard updates immediately.
   *
   * `userId` is a users.id (NOT a driver profile id). Callers that have
   * a driver profile id must resolve the user id first.
   */
  async notifyInApp(
    userId: string,
    type: string,
    title: string,
    body: string,
    data: Record<string, unknown> = {}
  ): Promise<void> {
    if (!userId) return;
    const [row] = await knex('notifications')
      .insert({
        user_id: userId,
        type,
        title,
        body,
        data,
        created_at: new Date(),
      })
      .returning('*');

    emitNotification({
      id: row.id,
      userId,
      type,
      title,
      body,
      data,
      createdAt: new Date(row.created_at).toISOString(),
    });
  }

  /**
   * Fetch the most recent in-app notifications for a user. Newest first.
   * Used by GET /notifications/my.
   */
  async listForUser(userId: string, limit = 50) {
    return knex('notifications')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .limit(Math.min(100, Math.max(1, limit)));
  }

  /**
   * Mark a single notification as read for a user. Returns the row count
   * (0 if it didn't exist or didn't belong to the user).
   */
  async markRead(userId: string, notificationId: string): Promise<number> {
    return knex('notifications')
      .where({ id: notificationId, user_id: userId })
      .update({ read_at: new Date() });
  }

  /**
   * Mark every unread notification belonging to the user as read.
   * Returns the row count updated. Idempotent — calling it twice
   * in a row is a no-op the second time.
   */
  async markAllRead(userId: string): Promise<number> {
    return knex('notifications')
      .where({ user_id: userId })
      .whereNull('read_at')
      .update({ read_at: new Date() });
  }
}

function shortId(id: string): string {
  return id.substring(0, 8).toUpperCase();
}

function statusLabel(status: OrderStatus): string {
  const map: Record<OrderStatus, string> = {
    pending: 'Pending',
    assigned: 'Assigned',
    picked_up: 'Picked Up',
    on_the_way: 'On The Way',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  };
  return map[status] ?? status;
}

// Export singleton instance
export const notificationService = new NotificationService();