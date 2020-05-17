const { sendSongMessage, disconnectVoiceConnection, getDebugContext } = require("../helpers/utils.js");
const logger = require("../logger")("stop");
module.exports = {
    call: ({ gameSessions, client, message }) => {
        let gameSession = gameSessions[message.guild.id];
        if (gameSession && gameSession.gameInSession()) {
            sendSongMessage(message, gameSession, true);
            disconnectVoiceConnection(client, message);
            gameSession.endRound();
            logger.info(`${getDebugContext(message)} | Game round ended: ${gameSession.getDebugSongDetails()}`);
        }
    },
    help: {
        name: "stop",
        description: "The game will be suspended and the bot will reveal the answer to any ongoing games in session.",
        usage: "!stop",
        arguments: []
    }
}