/* eslint-disable max-lines */
import type { Aggregate } from '~/aggregate';
import type { EventDetail } from '~/event/eventDetail';
import type { EventType, EventTypeDetails } from '~/event/eventType';
import type { GroupedEvent } from '~/event/groupedEvent';
import type { EventStorageAdapter } from '~/eventStorageAdapter';
import type { $Contravariant } from '~/utils';

import { AggregateNotFoundError } from './errors/aggregateNotFound';
import { UndefinedEventStorageAdapterError } from './errors/undefinedEventStorageAdapter';
import type {
  AggregateIdsLister,
  EventPusher,
  OnEventPushed,
  EventGroupPusher,
  EventGroupPusherResponse,
  EventsGetter,
  EventGrouper,
  SideEffectsSimulator,
  AggregateGetter,
  AggregateSimulator,
  Reducer,
} from './types';

export class EventStore<
  EVENT_STORE_ID extends string = string,
  EVENT_TYPES extends EventType[] = EventType[],
  EVENT_DETAILS extends EventDetail = EventTypeDetails<EVENT_TYPES>,
  // cf https://devblogs.microsoft.com/typescript/announcing-typescript-4-7-rc/#optional-variance-annotations-for-type-parameters
  // EventStore is contravariant on its fns args: We have to type them as "any" so that EventStore implementations still extends the EventStore type
  $EVENT_DETAILS extends EventDetail = $Contravariant<
    EVENT_DETAILS,
    EventDetail
  >,
  REDUCER extends Reducer<Aggregate, $EVENT_DETAILS> = Reducer<
    Aggregate,
    $EVENT_DETAILS
  >,
  AGGREGATE extends Aggregate = ReturnType<REDUCER>,
  $AGGREGATE extends Aggregate = $Contravariant<AGGREGATE, Aggregate>,
> {
  static pushEventGroup: EventGroupPusher = async <
    GROUPED_EVENTS extends [GroupedEvent, ...GroupedEvent[]],
  >(
    ...groupedEvents: GROUPED_EVENTS
  ) => {
    const [groupedEventsHead, ...groupedEventsTail] = groupedEvents;

    const { eventGroup: eventGroupWithoutAggregates } =
      await groupedEventsHead.eventStorageAdapter.pushEventGroup(
        groupedEventsHead,
        ...groupedEventsTail,
      );

    const eventGroupWithAggregates = eventGroupWithoutAggregates.map(
      ({ event }, eventIndex) => {
        const groupedEvent = groupedEvents[eventIndex];

        let nextAggregate: Aggregate | undefined = undefined;
        const prevAggregate = groupedEvent?.prevAggregate;

        if (
          (prevAggregate || event.version === 1) &&
          groupedEvent?.eventStore !== undefined
        ) {
          nextAggregate = groupedEvent.eventStore.reducer(prevAggregate, event);
        }

        return { event, ...(nextAggregate ? { nextAggregate } : {}) };
      },
    ) as EventGroupPusherResponse<GROUPED_EVENTS>;

    await Promise.all(
      groupedEvents.map((groupedEvent, eventIndex) => {
        const eventStore = groupedEvent.eventStore;
        const pushEventResponse = eventGroupWithAggregates[eventIndex];

        return pushEventResponse !== undefined &&
          eventStore?.onEventPushed !== undefined
          ? eventStore.onEventPushed(pushEventResponse)
          : null;
      }),
    );

    return { eventGroup: eventGroupWithAggregates };
  };

  _types?: {
    details: EVENT_DETAILS;
    aggregate: AGGREGATE;
  };
  eventStoreId: EVENT_STORE_ID;
  eventTypes: EVENT_TYPES;
  reducer: REDUCER;
  simulateSideEffect: SideEffectsSimulator<EVENT_DETAILS, $EVENT_DETAILS>;

  getEvents: EventsGetter<EVENT_DETAILS>;
  pushEvent: EventPusher<EVENT_DETAILS, $EVENT_DETAILS, AGGREGATE, $AGGREGATE>;
  onEventPushed?: OnEventPushed<$EVENT_DETAILS, $AGGREGATE>;
  groupEvent: EventGrouper<
    EVENT_DETAILS,
    $EVENT_DETAILS,
    AGGREGATE,
    $AGGREGATE
  >;
  listAggregateIds: AggregateIdsLister;

  buildAggregate: (
    events: $EVENT_DETAILS[],
    aggregate?: $AGGREGATE,
  ) => AGGREGATE | undefined;

  getAggregate: AggregateGetter<EVENT_DETAILS, AGGREGATE>;
  getExistingAggregate: AggregateGetter<EVENT_DETAILS, AGGREGATE, true>;
  simulateAggregate: AggregateSimulator<$EVENT_DETAILS, AGGREGATE>;
  eventStorageAdapter?: EventStorageAdapter;
  getEventStorageAdapter: () => EventStorageAdapter;

  constructor({
    eventStoreId,
    eventTypes,
    reducer,
    simulateSideEffect = (indexedEvents, event) => ({
      ...indexedEvents,
      [event.version]: event,
    }),
    eventStorageAdapter: $eventStorageAdapter,
  }: {
    eventStoreId: EVENT_STORE_ID;
    eventTypes: EVENT_TYPES;
    reducer: REDUCER;
    simulateSideEffect?: SideEffectsSimulator<EVENT_DETAILS, $EVENT_DETAILS>;
    eventStorageAdapter?: EventStorageAdapter;
  }) {
    this.eventStoreId = eventStoreId;
    this.eventTypes = eventTypes;
    this.reducer = reducer;
    this.simulateSideEffect = simulateSideEffect;
    this.eventStorageAdapter = $eventStorageAdapter;

    this.getEventStorageAdapter = () => {
      if (!this.eventStorageAdapter) {
        throw new UndefinedEventStorageAdapterError({
          eventStoreId: this.eventStoreId,
        });
      }

      return this.eventStorageAdapter;
    };

    this.getEvents = (aggregateId, queryOptions) =>
      this.getEventStorageAdapter().getEvents(
        aggregateId,
        { eventStoreId: this.eventStoreId },
        queryOptions,
        /**
         * @debt feature "For the moment we just cast, we could implement validation + type guards at EventType level"
         */
      ) as Promise<{ events: EVENT_DETAILS[] }>;

    this.pushEvent = async (
      eventDetail,
      { prevAggregate, force = false } = {},
    ) => {
      const eventStorageAdapter = this.getEventStorageAdapter();

      const { event } = (await eventStorageAdapter.pushEvent(eventDetail, {
        eventStoreId: this.eventStoreId,
        force,
      })) as { event: $EVENT_DETAILS };

      let nextAggregate: AGGREGATE | undefined = undefined;
      if (prevAggregate || event.version === 1) {
        nextAggregate = this.reducer(prevAggregate, event) as AGGREGATE;
      }

      const response = {
        event: event as unknown as EVENT_DETAILS,
        ...(nextAggregate ? { nextAggregate } : {}),
      };

      if (this.onEventPushed !== undefined) {
        await this.onEventPushed(
          response as unknown as {
            event: $EVENT_DETAILS;
            nextAggregate?: $AGGREGATE;
          },
        );
      }

      return response;
    };

    this.groupEvent = (eventDetail, { prevAggregate } = {}) => {
      const eventStorageAdapter = this.getEventStorageAdapter();

      const groupedEvent = eventStorageAdapter.groupEvent(
        eventDetail,
      ) as GroupedEvent<EVENT_DETAILS, AGGREGATE>;

      groupedEvent.eventStore = this;
      groupedEvent.context = { eventStoreId: this.eventStoreId };

      if (prevAggregate !== undefined) {
        groupedEvent.prevAggregate = prevAggregate as unknown as AGGREGATE;
      }

      return groupedEvent;
    };

    this.listAggregateIds = options =>
      this.getEventStorageAdapter().listAggregateIds(
        { eventStoreId: this.eventStoreId },
        options,
      );

    this.buildAggregate = (eventDetails, aggregate) =>
      eventDetails.reduce(this.reducer, aggregate) as AGGREGATE | undefined;

    this.getAggregate = async (aggregateId, { maxVersion } = {}) => {
      const { events } = await this.getEvents(aggregateId, { maxVersion });

      const aggregate = this.buildAggregate(
        events as unknown as $EVENT_DETAILS[],
        undefined,
      );

      const lastEvent = events[events.length - 1];

      return { aggregate, events, lastEvent };
    };

    this.getExistingAggregate = async (aggregateId, options) => {
      const { aggregate, lastEvent, ...restAggregate } =
        await this.getAggregate(aggregateId, options);

      if (aggregate === undefined || lastEvent === undefined) {
        throw new AggregateNotFoundError({
          aggregateId,
          eventStoreId: this.eventStoreId,
        });
      }

      return { aggregate, lastEvent, ...restAggregate };
    };

    this.simulateAggregate = (events, { simulationDate } = {}) => {
      let eventsWithSideEffects = Object.values(
        events.reduce(
          this.simulateSideEffect as unknown as (
            indexedEvents: Record<string, Omit<$EVENT_DETAILS, 'version'>>,
            event: $EVENT_DETAILS,
          ) => Record<string, Omit<$EVENT_DETAILS, 'version'>>,
          {} as Record<string, $EVENT_DETAILS>,
        ),
      );

      if (simulationDate !== undefined) {
        eventsWithSideEffects = eventsWithSideEffects.filter(
          ({ timestamp }) => timestamp <= simulationDate,
        );
      }

      const sortedEventsWithSideEffects = eventsWithSideEffects
        .sort(({ timestamp: timestampA }, { timestamp: timestampB }) =>
          timestampA < timestampB ? -1 : 1,
        )
        .map((event, index) => ({
          ...event,
          version: index + 1,
        })) as $EVENT_DETAILS[];

      return this.buildAggregate(sortedEventsWithSideEffects);
    };
  }
}
