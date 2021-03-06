const errors = require('../../errors');

const AssetsService = require('../../services/assets');
const ActionsService = require('../../services/actions');
const CommentsService = require('../../services/comments');
const linkify = require('linkify-it')();

const Wordlist = require('../../services/wordlist');

/**
 * Creates a new comment.
 * @param  {Object} user          the user performing the request
 * @param  {String} body          body of the comment
 * @param  {String} asset_id      asset for the comment
 * @param  {String} parent_id     optional parent of the comment
 * @param  {String} [status='NONE'] the status of the new comment
 * @return {Promise}              resolves to the created comment
 */
const createComment = ({user, loaders: {Comments}}, {body, asset_id, parent_id = null}, status = 'NONE') => {

  let tags = [];
  if (user.hasRoles('ADMIN') || user.hasRoles('MODERATOR')) {
    tags = [{name: 'STAFF'}];
  }

  return CommentsService.publicCreate({
    body,
    asset_id,
    parent_id,
    status,
    tags,
    author_id: user.id
  })
  .then((comment) => {

    // If the loaders are present, clear the caches for these values because we
    // just added a new comment, hence the counts should be updated. We should
    // perform these increments in the event that we do have a new comment that
    // is approved or without a comment.
    if (status === 'NONE' || status === 'APPROVED') {
      if (parent_id != null) {
        Comments.countByParentID.incr(parent_id);
      } else {
        Comments.parentCountByAssetID.incr(asset_id);
      }
      Comments.countByAssetID.incr(asset_id);
    }

    return comment;
  });
};

/**
 * Filters the comment object and outputs wordlist results.
 * @param  {Object} context graphql context
 * @param  {String} body    body of a comment
 * @return {Object}         resolves to the wordlist results
 */
const filterNewComment = (context, {body, asset_id}) => {

  // Create a new instance of the Wordlist.
  const wl = new Wordlist();

  // Load the wordlist and filter the comment content.
  return Promise.all([
    wl.load().then(() => wl.scan('body', body)),
    AssetsService.rectifySettings(AssetsService.findById(asset_id))
  ]);
};

/**
 * This resolves a given comment's status to take into account moderator actions
 * are applied.
 * @param  {Object} context       graphql context
 * @param  {String} body          body of the comment
 * @param  {String} asset_id      asset for the comment
 * @param  {Object} [wordlist={}] the results of the wordlist scan
 * @return {Promise}              resolves to the comment's status
 */
const resolveNewCommentStatus = (context, {asset_id, body}, wordlist = {}, settings) => {

  // Decide the status based on whether or not the current asset/settings
  // has pre-mod enabled or not. If the comment was rejected based on the
  // wordlist, then reject it, otherwise if the moderation setting is
  // premod, set it to `premod`.
  let status;

  if (wordlist.banned) {
    status = Promise.resolve('REJECTED');
  } else if (settings.premodLinksEnable && linkify.test(body)) {
    status = Promise.resolve('PREMOD');
  } else {
    status = AssetsService
      .rectifySettings(AssetsService.findById(asset_id).then((asset) => {
        if (!asset) {
          return Promise.reject(errors.ErrNotFound);
        }

        // Check to see if the asset has closed commenting...
        if (asset.isClosed) {

          // They have, ensure that we send back an error.
          return Promise.reject(new errors.ErrAssetCommentingClosed(asset.closedMessage));
        }

        return asset;
      }))

      // Return `premod` if pre-moderation is enabled and an empty "new" status
      // in the event that it is not in pre-moderation mode.
      .then(({moderation, charCountEnable, charCount}) => {

        // Reject if the comment is too long
        if (charCountEnable && body.length > charCount) {
          return 'REJECTED';
        }
        return moderation === 'PRE' ? 'PREMOD' : 'NONE';
      });
  }

  return status;
};

/**
 * createPublicComment is designed to create a comment from a public source. It
 * validates the comment, and performs some automated moderator actions based on
 * the settings.
 * @param  {Object} context      the graphql context
 * @param  {Object} commentInput the new comment to be created
 * @return {Promise}             resolves to a new comment
 */
const createPublicComment = (context, commentInput) => {

  // First we filter the comment contents to ensure that we note any validation
  // issues.
  return filterNewComment(context, commentInput)

    // We then take the wordlist and the comment into consideration when
    // considering what status to assign the new comment, and resolve the new
    // status to set the comment to.
    .then(([wordlist, settings]) => resolveNewCommentStatus(context, commentInput, wordlist, settings)

      // Then we actually create the comment with the new status.
      .then((status) => createComment(context, commentInput, status))
      .then((comment) => {

        // If the comment has a suspect word or a link, we need to add a
        // flag to it to indicate that it needs to be looked at.
        // Otherwise just return the new comment.

        // TODO: Check why the wordlist is undefined
        if (wordlist != null && wordlist.suspect != null) {

          // TODO: this is kind of fragile, we should refactor this to resolve
          // all these const's that we're using like 'COMMENTS', 'FLAG' to be
          // defined in a checkable schema.
          return ActionsService.insertUserAction({
            item_id: comment.id,
            item_type: 'COMMENTS',
            action_type: 'FLAG',
            user_id: null,
            group_id: 'Matched suspect word filter',
            metadata: {}
          })
          .then(() => comment);
        }

        // Finally, we return the comment.
        return comment;
      }));
};

/**
 * Sets the status of a comment
 * @param {String} comment     comment in graphql context
 * @param {String} id          identifier of the comment  (uuid)
 * @param {String} status      the new status of the comment
 */

const setCommentStatus = ({loaders: {Comments}}, {id, status}) => {
  return CommentsService
    .setStatus(id, status)
    .then((comment) => {

      // If the loaders are present, clear the caches for these values because we
      // just added a new comment, hence the counts should be updated. It would
      // be nice if we could decrement the counters here, but that would result
      // in us having to know the initial state of the comment, which would
      // require another database query.
      if (comment.parent_id != null) {
        Comments.countByParentID.clear(comment.parent_id);
      } else {
        Comments.parentCountByAssetID.clear(comment.asset_id);
      }

      Comments.countByAssetID.clear(comment.asset_id);

      return comment;
    });
};

/**
 * Adds a tag to a Comment
 * @param {String} id          identifier of the comment  (uuid)
 * @param {String} tag     name of the tag
 */
const addCommentTag = ({user, loaders: {Comments}}, {id, tag}) => {
  return CommentsService.addTag(id, tag, user.id);
};

/**
 * Removes a tag from a Comment
 * @param {String} id          identifier of the comment  (uuid)
 * @param {String} tag     name of the tag
 */
const removeCommentTag = ({user, loaders: {Comments}}, {id, tag}) => {
  return CommentsService.removeTag(id, tag);
};

module.exports = (context) => {
  let mutators = {
    Comment: {
      create: () => Promise.reject(errors.ErrNotAuthorized),
      setCommentStatus: () => Promise.reject(errors.ErrNotAuthorized),
      addCommentTag: () => Promise.reject(errors.ErrNotAuthorized),
      removeCommentTag: () => Promise.reject(errors.ErrNotAuthorized),
    }
  };

  if (context.user && context.user.can('mutation:createComment')) {
    mutators.Comment.create = (comment) => createPublicComment(context, comment);
  }

  if (context.user && context.user.can('mutation:setCommentStatus')) {
    mutators.Comment.setCommentStatus = (action) => setCommentStatus(context, action);
  }

  if (context.user && context.user.can('mutation:addCommentTag')) {
    mutators.Comment.addCommentTag = (action) => addCommentTag(context, action);
  }

  if (context.user && context.user.can('mutation:removeCommentTag')) {
    mutators.Comment.removeCommentTag = (action) => removeCommentTag(context, action);
  }

  return mutators;
};
