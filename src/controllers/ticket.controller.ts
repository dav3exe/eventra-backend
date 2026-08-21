import { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { sendTsRestError, sendTsRestSuccess } from '../lib/responseHandler.js'
import tryCatchWrapper from '../lib/tryCatchWrapper.js'
import Event from '../models/event.js'
import Order, { calculateOrderTotals } from '../models/order.js'
import RefundRequest from '../models/refundRequest.js'
import Ticket from '../models/ticket.js'
import TicketType from '../models/ticketType.js'
import { PaystackService } from '../services/paystack.service.js'
import { TicketService } from '../services/ticket.service.js'
import { handleTicketOrderPayment } from './payment.controller.js'
import { resolveAttendeeInfo, ticketBelongsToRequester } from '../lib/attendee.js'
import { env } from '../config/keys.js'
import { generateQrCodeBuffer, generateQrCodeDataUrl } from '../lib/qrcode.js'
import { checkRefundEligibility } from '../lib/refundPolicy.js'
import { buildPaginationMeta, getPagination, generateOTP, escapeRegExp } from '../lib/utils.js'
import GuestAccessCode from '../models/guestAccessCode.js'
import { EmailService } from '../services/email.service.js'
import logger from '../config/logger.js'

const NAIRA_TO_KOBO = 100

export const rsvpFreeEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  const { guests, guestName, guestEmail, guestPhone } = req.body as {
    guests?: number
    guestName?: string
    guestEmail?: string
    guestPhone?: string
  }

  const attendee = await resolveAttendeeInfo(req, { guestName, guestEmail, guestPhone })
  if (!attendee) {
    return sendTsRestError(res, 400, 'Log in, or provide your name and email to reserve without an account')
  }

  try {
    const tickets = await TicketService.rsvpToFreeEvent(eventId as string, attendee, guests ?? 1)
    return sendTsRestSuccess(res, 201, {
      success: true,
      message: tickets.length > 1 ? `Reservation confirmed for ${tickets.length} guests` : 'Reservation confirmed',
      body: tickets.map(t => t.toObject()),
    })
  } catch (error: any) {
    return sendTsRestError(res, 400, error.message || 'Could not complete reservation')
  }
})

/**
 * Lets the client poll "did my payment go through?" after Paystack redirects
 * back to /checkout/callback?reference=... . The webhook (handleTicketOrderPayment
 * in payment.controller.ts) is what's *supposed* to flip order status —
 * but webhook delivery needs Paystack's servers to reach ours, which isn't
 * guaranteed (local dev, a stale dashboard URL, a dropped delivery). So
 * whenever this finds a still-'pending' order, it re-runs that same
 * reconciliation itself before responding — self-healing the poll instead
 * of leaving the client stuck watching a status that will never change on
 * its own. Still never trusts the client for this: reconciliation always
 * re-verifies directly against Paystack's API, exactly like the webhook does.
 */
export const getOrderByReference = tryCatchWrapper(async (req: Request, res: Response) => {
  const { reference } = req.params

  // Logged in: still scoped to their own orders, same as before. No
  // session (guest checkout): the reference itself — an unguessable
  // randomUUID-based string only ever shown to whoever completed this
  // specific checkout — is treated as the access key, same trust model as
  // a payment receipt link.
  const filter = req.session?.userId ? { paystackReference: reference, buyer: req.session.userId } : { paystackReference: reference }

  let order = await Order.findOne(filter).populate('event', 'title slug startDate venue coverImage refundPolicy').lean()

  if (!order) {
    return sendTsRestError(res, 404, 'Order not found')
  }

  if (order.status === 'pending') {
    try {
      await handleTicketOrderPayment(reference as string)
    } catch (error: any) {
      // Paystack's API might just be slow/unreachable this instant — leave
      // the order 'pending' and let the next poll (or the webhook, if it
      // does eventually land) try again rather than failing this request.
      logger.error(`getOrderByReference: reconciliation attempt failed for ${reference}: ${error.message}`)
    }
    order = await Order.findOne(filter).populate('event', 'title slug startDate venue coverImage').lean()
    if (!order) {
      return sendTsRestError(res, 404, 'Order not found')
    }
  }

  // Included directly rather than making the client cross-reference
  // /tickets/my-tickets — that endpoint requires a session, which a guest
  // checkout doesn't have, so relying on it here would leave a guest stuck
  // on the "confirming payment" screen forever even after paying.
  const tickets =
    order.status === 'paid'
      ? await Ticket.find({ order: order._id }).populate('event', 'title slug startDate venue coverImage refundPolicy').populate('ticketType', 'name').lean()
      : []

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Order fetched',
    body: { ...order, tickets },
  })
})

export const initializeCheckout = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  const {
    items,
    guestName,
    guestEmail,
    guestPhone,
  } = req.body as {
    items: { ticketTypeId: string; quantity: number }[]
    guestName?: string
    guestEmail?: string
    guestPhone?: string
  }

  const [event, attendee] = await Promise.all([
    Event.findById(eventId),
    resolveAttendeeInfo(req, { guestName, guestEmail, guestPhone }),
  ])

  if (!event || event.type !== 'paid' || event.status !== 'approved') {
    return sendTsRestError(res, 404, 'This event is not open for ticket purchases')
  }
  if (!attendee) {
    return sendTsRestError(res, 400, 'Log in, or provide your name and email to check out without an account')
  }

  const ticketTypeIds = items.map(item => item.ticketTypeId)
  const ticketTypes = await TicketType.find({ _id: { $in: ticketTypeIds }, event: event._id, isActive: true })

  if (ticketTypes.length !== ticketTypeIds.length) {
    return sendTsRestError(res, 400, 'One or more ticket types are invalid for this event')
  }

  const orderItems: { ticketType: any; quantity: number; unitPrice: number }[] = []

  for (const item of items) {
    const ticketType = ticketTypes.find(tt => tt._id.toString() === item.ticketTypeId)!
    const remaining = ticketType.quantity - ticketType.quantitySold

    if (item.quantity > ticketType.purchaseLimitPerPerson) {
      return sendTsRestError(res, 400, `You can buy at most ${ticketType.purchaseLimitPerPerson} "${ticketType.name}" tickets`)
    }
    if (item.quantity > remaining) {
      return sendTsRestError(res, 400, `Only ${remaining} "${ticketType.name}" tickets remain`)
    }

    orderItems.push({ ticketType: ticketType._id, quantity: item.quantity, unitPrice: ticketType.price })
  }

  const totals = calculateOrderTotals(orderItems)
  const reference = `EVT-${event._id.toString().slice(-6)}-${randomUUID()}`

  const order = await Order.create({
    event: event._id,
    ...(attendee.userId
      ? { buyer: attendee.userId }
      : { guestName: attendee.fullname, guestEmail: attendee.email, guestPhone: attendee.phone }),
    items: orderItems,
    ...totals,
    status: 'pending',
    paystackReference: reference,
  })

  try {
    const paystackTx = await PaystackService.initializeTransaction({
      email: attendee.email,
      amountKobo: Math.round(totals.total * NAIRA_TO_KOBO),
      reference,
      callbackUrl: `${env.CLIENT_URL}/checkout/callback`,
      metadata: { orderId: order._id.toString(), eventId: event._id.toString() },
    })

    return sendTsRestSuccess(res, 201, {
      success: true,
      message: 'Checkout initialized',
      body: {
        orderId: order._id,
        reference,
        authorizationUrl: paystackTx.authorizationUrl,
        total: totals.total,
      },
    })
  } catch (error: any) {
    order.status = 'failed'
    await order.save()
    return sendTsRestError(res, 502, error.message || 'Could not start payment with Paystack')
  }
})

/**
 * An attendee cancels their own free-event reservation, releasing the place.
 * No payment is involved for free events, so this is a straight cancellation.
 */
/**
 * Cancelling a free reservation deletes the ticket outright rather than
 * soft-marking it 'cancelled' — unlike a paid ticket (see requestRefund
 * below), there's no payment or audit trail tied to a free RSVP that's
 * worth preserving, and leaving a dead row around just meant it kept
 * showing up in My Tickets forever with nothing useful to do with it.
 */
export const cancelReservation = tryCatchWrapper(async (req: Request, res: Response) => {
  const { ticketId } = req.params

  const ticket = await Ticket.findOne({ _id: ticketId, type: 'free' })
  if (!ticket || !ticketBelongsToRequester(req, ticket)) {
    return sendTsRestError(res, 404, 'Reservation not found')
  }
  if (ticket.status !== 'valid') {
    return sendTsRestError(res, 400, 'This reservation can no longer be cancelled')
  }

  await ticket.deleteOne()
  await Event.updateOne({ _id: ticket.event }, { $inc: { reservationsCount: -1 } })

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Reservation cancelled',
  })
})

/**
 * An attendee requests a refund for a paid ticket. Subject to the event's
 * refund policy — except a postponed event, where a refund can always be requested.
 */
export const requestRefund = tryCatchWrapper(async (req: Request, res: Response) => {
  const { ticketId } = req.params
  const { reason } = req.body as { reason?: string }

  const ticket = await Ticket.findOne({ _id: ticketId, type: 'paid' })
  if (!ticket || !ticketBelongsToRequester(req, ticket)) {
    return sendTsRestError(res, 404, 'Ticket not found')
  }
  if (ticket.status !== 'valid' && ticket.status !== 'checked_in') {
    return sendTsRestError(res, 400, 'This ticket is not eligible for a refund')
  }

  const event = await Event.findById(ticket.event)
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  const eligibility = checkRefundEligibility(event.status, event.refundPolicy, event.startDate)
  if (!eligibility.allowed) {
    return sendTsRestError(res, 400, eligibility.reason ?? 'This ticket is not eligible for a refund')
  }

  const existingRequest = await RefundRequest.findOne({ ticket: ticket._id, status: { $in: ['pending', 'approved'] } })
  if (existingRequest) {
    return sendTsRestError(res, 409, 'A refund request is already in progress for this ticket')
  }

  const refundRequest = await RefundRequest.create({
    ticket: ticket._id,
    order: ticket.order,
    event: ticket.event,
    requestedBy: req.session?.userId,
    reason,
    amount: ticket.price,
  })

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Refund request submitted for admin review',
    body: refundRequest.toObject(),
  })
})

const GUEST_ACCESS_OTP_TTL_MS = 15 * 60 * 1000 // matches the copy in guestTicketAccessTemplate

/**
 * Step 1 of "track my ticket by email" — always returns a generic success
 * message regardless of whether this email actually has any tickets, so
 * this can't be used to enumerate who has bought/reserved what.
 */
export const requestGuestTicketAccess = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email } = req.body as { email: string }
  const normalizedEmail = email.trim().toLowerCase()

  const hasAnyTickets = await Ticket.exists({ attendeeEmail: normalizedEmail })
  if (hasAnyTickets) {
    const otp = generateOTP()
    await GuestAccessCode.create({
      email: normalizedEmail,
      otp,
      otpExpiry: new Date(Date.now() + GUEST_ACCESS_OTP_TTL_MS),
    })
    EmailService.sendGuestTicketAccessEmail({ email: normalizedEmail, otp }).catch(error =>
      logger.error({ err: error }, `Guest ticket access email failed for ${normalizedEmail}`)
    )
  }

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: "If that email has any tickets, we've sent a code to access them.",
  })
})

/**
 * Step 2 — verifying the code sets req.session.guestEmail, which is what
 * ticketBelongsToRequester (lib/attendee.ts) checks for cancelReservation /
 * requestRefund / getTicketQrCode from here on. Also returns the ticket
 * list directly so the client doesn't need a third round-trip.
 */
export const verifyGuestTicketAccess = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email, otp } = req.body as { email: string; otp: string }
  const normalizedEmail = email.trim().toLowerCase()

  const accessCode = await GuestAccessCode.findOne({ email: normalizedEmail, otp }).sort({ createdAt: -1 })
  if (!accessCode || accessCode.otpExpiry.getTime() < Date.now()) {
    return sendTsRestError(res, 400, 'Invalid or expired code')
  }

  await GuestAccessCode.deleteMany({ email: normalizedEmail })
  req.session.guestEmail = normalizedEmail

  const tickets = await Ticket.find({ attendeeEmail: normalizedEmail })
    .populate('event', 'title slug startDate venue coverImage')
    .populate('ticketType', 'name')
    .sort({ createdAt: -1 })
    .lean()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Access granted',
    body: tickets,
  })
})

/**
 * Re-lists a verified guest's tickets without re-sending a code — used
 * when they come back to the tracking page later in the same browser
 * session (req.session.guestEmail persists via the normal session cookie).
 */
export const listGuestTickets = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.session.guestEmail) {
    return sendTsRestError(res, 401, 'Verify your email to view your tickets')
  }

  const tickets = await Ticket.find({ attendeeEmail: req.session.guestEmail })
    .populate('event', 'title slug startDate venue coverImage refundPolicy')
    .populate('ticketType', 'name')
    .sort({ createdAt: -1 })
    .lean()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Tickets fetched',
    body: tickets,
  })
})

export const myTickets = tryCatchWrapper(async (req: Request, res: Response) => {
  const tickets = await Ticket.find({ attendee: req.session.userId })
    .populate('event', 'title slug startDate venue coverImage refundPolicy')
    .populate('ticketType', 'name')
    .sort({ createdAt: -1 })
    .lean()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Tickets fetched',
    body: tickets,
  })
})

export const getTicketQrCode = tryCatchWrapper(async (req: Request, res: Response) => {
  const { ticketId } = req.params

  const ticket = await Ticket.findOne({ _id: ticketId }).lean()
  if (!ticket || !ticketBelongsToRequester(req, ticket)) {
    return sendTsRestError(res, 404, 'Ticket not found')
  }

  const qrCodeDataUrl = await generateQrCodeDataUrl(ticket.code)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'QR code generated',
    body: { qrCodeDataUrl },
  })
})

/**
 * Serves the QR as an actual image response (Content-Type: image/png),
 * not JSON — for use in <img src="..."> tags, specifically the
 * confirmation email (see ticketConfirmationTemplate). That's the one
 * place a plain browser session check can't work: an email client's image
 * loader is just an anonymous GET, no cookies attached, so
 * getTicketQrCode above always 404s for it (ticketBelongsToRequester has
 * nothing to check against). Keyed by `code` instead of `_id` on purpose —
 * `code` is itself an unguessable secret (see generateTicketCode), so
 * knowing it is already equivalent proof of ownership, the same trust
 * model getOrderByReference above already uses for the same reason.
 */
export const getTicketQrCodeImage = tryCatchWrapper(async (req: Request, res: Response) => {
  const { code } = req.params

  const ticket = await Ticket.findOne({ code }).select('code').lean()
  if (!ticket) {
    return res.status(404).end()
  }

  const qrCodeBuffer = await generateQrCodeBuffer(ticket.code)

  res.setHeader('Content-Type', 'image/png')
  // A ticket's code never changes once issued, so this image is
  // permanently cacheable — email clients and proxies fetching it
  // repeatedly (some re-fetch on every open) don't need to hit this
  // endpoint more than once per client.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  return res.send(qrCodeBuffer)
})

/**
 * Scan a ticket's QR code at the door. Always returns one of three clear
 * results — valid / already_used / invalid — matching the PRD's
 * green-Valid / red-Already-used-or-Not-valid scanner UI.
 * The atomic status flip at the end makes repeated/offline-queued scans of
 * the same code safe to replay once connectivity returns.
 */
export const checkInTicket = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  const { code } = req.body as { code: string }

  const event = await Event.findOne({ _id: eventId, organizer: req.session.userId })
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  const ticket = await Ticket.findOne({ code })

  if (!ticket || ticket.event.toString() !== event._id.toString()) {
    return sendTsRestSuccess(res, 200, {
      success: true,
      message: 'Not valid',
      body: { result: 'invalid' },
    })
  }

  if (ticket.status !== 'valid') {
    return sendTsRestSuccess(res, 200, {
      success: true,
      message: ticket.status === 'checked_in' ? 'Already checked in' : `Ticket is ${ticket.status}`,
      body: { result: 'already_used', checkedInAt: ticket.checkedInAt ?? null },
    })
  }

  // Atomic guard: if two scans race, only one flips valid → checked_in.
  const updated = await Ticket.findOneAndUpdate(
    { _id: ticket._id, status: 'valid' },
    { $set: { status: 'checked_in', checkedInAt: new Date(), checkedInBy: req.session.userId } },
    { new: true }
  )

  if (!updated) {
    return sendTsRestSuccess(res, 200, {
      success: true,
      message: 'Already checked in',
      body: { result: 'already_used' },
    })
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Valid',
    body: { result: 'valid', ticket: updated.toObject() },
  })
})

export const listEventAttendees = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  const event = await Event.findOne({ _id: eventId, organizer: req.session.userId })
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  if (req.query.format === 'csv') {
    // Full export — never paginated, the organizer needs every row.
    const tickets = await Ticket.find({ event: event._id }).populate('ticketType', 'name').sort({ createdAt: -1 }).lean()

    const header = 'name,email,ticket_type,price,status,checked_in_at\n'
    const rows = tickets
      .map(t => {
        const ticketTypeName = (t.ticketType as any)?.name ?? 'Free RSVP'
        return [t.attendeeName, t.attendeeEmail, ticketTypeName, t.price, t.status, t.checkedInAt ?? '']
          .map(value => `"${String(value).replace(/"/g, '""')}"`)
          .join(',')
      })
      .join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${event.slug}-attendees.csv"`)
    res.status(200).send(header + rows)
    return
  }

  const { page, limit, skip } = getPagination(req.query)

  // Base filter, scoped to the event only — used for the stat counts below
  // so "Total"/"Checked in"/"Not in" always reflect the whole event, not
  // whatever search/status filter is currently applied to the list.
  const baseFilter: Record<string, any> = { event: event._id }

  const filter: Record<string, any> = { ...baseFilter }

  // "checked_in" is its own status; "not_in" covers every ticket that
  // hasn't been checked in yet (valid, cancelled, refunded) — matches the
  // Attendees page's All / Checked in / Not in segmented filter.
  const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined
  if (statusParam === 'checked_in') {
    filter.status = 'checked_in'
  } else if (statusParam === 'not_in') {
    filter.status = { $ne: 'checked_in' }
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), 'i')
    filter.$or = [{ attendeeName: pattern }, { attendeeEmail: pattern }, { code: pattern }]
  }

  const [tickets, total, checkedInCount] = await Promise.all([
    Ticket.find(filter).populate('ticketType', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Ticket.countDocuments(filter),
    Ticket.countDocuments({ ...baseFilter, status: 'checked_in' }),
  ])

  const totalForEvent = await Ticket.countDocuments(baseFilter)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Attendees fetched',
    body: {
      tickets,
      meta: buildPaginationMeta(page, limit, total),
      stats: { total: totalForEvent, checkedIn: checkedInCount, notIn: totalForEvent - checkedInCount },
    },
  })
})
