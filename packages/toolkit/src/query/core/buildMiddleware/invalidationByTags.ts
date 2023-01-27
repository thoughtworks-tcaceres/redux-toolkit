import {
  isAnyOf,
  isFulfilled,
  isRejected,
  isRejectedWithValue,
} from '../rtkImports'

import type {
  EndpointDefinitions,
  FullTagDescription,
} from '../../endpointDefinitions'
import { calculateProvidedBy } from '../../endpointDefinitions'
import type { CombinedState, QueryCacheKey } from '../apiState'
import { QueryStatus } from '../apiState'
import { calculateProvidedByThunk } from '../buildThunks'
import type {
  SubMiddlewareApi,
  InternalHandlerBuilder,
  ApiMiddlewareInternalHandler,
  InternalMiddlewareState,
} from './types'
import { countObjectKeys } from '../../utils/countObjectKeys'

export const buildInvalidationByTagsHandler: InternalHandlerBuilder = ({
  reducerPath,
  context,
  context: { endpointDefinitions },
  mutationThunk,
  queryThunk,
  api,
  assertTagType,
  refetchQuery,
  internalState,
}) => {
  const { removeQueryResult } = api.internalActions
  const isThunkActionWithTags = isAnyOf(
    isFulfilled(mutationThunk),
    isRejectedWithValue(mutationThunk)
  )

  const isQueryEnd = isAnyOf(
    isFulfilled(mutationThunk),
    isRejected(mutationThunk),
    isFulfilled(queryThunk),
    isRejected(queryThunk)
  )

  let pendingTagInvalidations: FullTagDescription<string>[] = []

  const handler: ApiMiddlewareInternalHandler = (action, mwApi) => {
    if (isThunkActionWithTags(action)) {
      invalidateTags(
        calculateProvidedByThunk(
          action,
          'invalidatesTags',
          endpointDefinitions,
          assertTagType
        ),
        mwApi
      )
    } else if (isQueryEnd(action)) {
      invalidateTags([], mwApi)
    } else if (api.util.invalidateTags.match(action)) {
      invalidateTags(
        calculateProvidedBy(
          action.payload,
          undefined,
          undefined,
          undefined,
          undefined,
          assertTagType
        ),
        mwApi
      )
    }
  }

  function invalidateTags(
    newTags: readonly FullTagDescription<string>[],
    mwApi: SubMiddlewareApi
  ) {
    const rootState = mwApi.getState()
    const state = rootState[reducerPath]

    pendingTagInvalidations.push(...newTags)

    if (!state.config.invalidateImmediately) {
      const hasPendingRequests = Object.values({
        ...state.queries,
        ...state.mutations,
      }).some((x) => x?.status === QueryStatus.pending)

      if (hasPendingRequests) return
    }

    const tags = pendingTagInvalidations
    pendingTagInvalidations = []
    if (tags.length === 0) return

    const toInvalidate = api.util.selectInvalidatedBy(rootState, tags)

    context.batch(() => {
      const valuesArray = Array.from(toInvalidate.values())
      for (const { queryCacheKey } of valuesArray) {
        const querySubState = state.queries[queryCacheKey]
        const subscriptionSubState =
          internalState.currentSubscriptions[queryCacheKey] ?? {}

        if (querySubState) {
          if (countObjectKeys(subscriptionSubState) === 0) {
            mwApi.dispatch(
              removeQueryResult({
                queryCacheKey: queryCacheKey as QueryCacheKey,
              })
            )
          } else if (querySubState.status !== QueryStatus.uninitialized) {
            mwApi.dispatch(refetchQuery(querySubState, queryCacheKey))
          }
        }
      }
    })
  }

  return handler
}
