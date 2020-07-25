import { CommandArgs } from "commands/base_command";
import { songCacheDir as SONG_CACHE_DIR } from "../../config/app_config.json";
import { getUserIdentifier, sendSongMessage, getDebugContext, sendErrorMessage } from "./discord_utils";
import _logger from "../logger";
import { resolve } from "path"
import * as fs from "fs";
import GameSession from "models/game_session";
import GuildPreference from "models/guild_preference";
import { getAudioDurationInSeconds } from "get-audio-duration";
import * as Discord from "discord.js";
import { QueriedSong, Databases } from "types";
import { SEEK_TYPES } from "../commands/seek";
import { isDebugMode, getForcePlaySong, skipSongPlay, isForcedSongActive } from "./debug_utils";
const GameOptions: { [option: string]: string } = { "GENDER": "Gender", "CUTOFF": "Cutoff", "LIMIT": "Limit", "VOLUME": "Volume", "SEEK_TYPE": "Seek Type", "GROUPS": "Groups" };

const logger = _logger("game_utils");


const guessSong = async ({ client, message, gameSessions, guildPreference, db }: CommandArgs) => {
    const voiceConnection = client.voiceConnections.get(message.guild.id);
    if (!voiceConnection || !voiceConnection.channel.members.has(message.author.id)) {
        return;
    }
    let gameSession = gameSessions[message.guild.id];
    let guess = cleanSongName(message.content);
    let cleanedSongAliases = gameSession.getSongAliases().map((x) => cleanSongName(x));
    if (gameSession.getSong() && (guess === cleanSongName(gameSession.getSong()) || cleanedSongAliases.includes(guess))) {
        // this should be atomic
        let userTag = getUserIdentifier(message.author);
        gameSession.scoreboard.updateScoreboard(userTag, message.author.id);
        await sendSongMessage(message, gameSession, false);
        logger.info(`${getDebugContext(message)} | Song correctly guessed. song = ${gameSession.getSong()}`)
        await gameSession.endRound();
        if (gameSession.connection) {
            let stream: any = resolve("assets/ring.wav");
            gameSession.connection.playFile(stream);
        }
        setTimeout(() => {
            startGame(gameSession, guildPreference, db, message, client, null);
        }, 2000);
    }
}

const getFilteredSongList = async (guildPreference: GuildPreference, db: Databases): Promise<{ songs: QueriedSong[], countBeforeLimit: number }> => {
    let result;
    if (guildPreference.getGroupIds() === null) {
        result = await db.kpopVideos("kpop_videos.app_kpop")
            .select(["nome as name", "name as artist", "vlink as youtubeLink"])
            .join("kpop_videos.app_kpop_group", function () {
                this.on("kpop_videos.app_kpop.id_artist", "=", "kpop_videos.app_kpop_group.id")
            })
            .whereIn("members", guildPreference.getSQLGender().split(","))
            .andWhere("dead", "n")
            .andWhere("publishedon", ">=", `${guildPreference.getBeginningCutoffYear()}-01-01`)
            .andWhere("publishedon", "<=", `${guildPreference.getEndCutoffYear()}-12-31`)
            .andWhere("vtype", "main")
            .orderBy("kpop_videos.app_kpop.views", "DESC")
    }
    else {
        result = await db.kpopVideos("kpop_videos.app_kpop")
            .select(["nome as name", "name as artist", "vlink as youtubeLink"])
            .join("kpop_videos.app_kpop_group", function () {
                this.on("kpop_videos.app_kpop.id_artist", "=", "kpop_videos.app_kpop_group.id")
            })
            .whereIn("id_artist", guildPreference.getGroupIds())
            .andWhere("dead", "n")
            .andWhere("publishedon", ">=", `${guildPreference.getBeginningCutoffYear()}-01-01`)
            .andWhere("publishedon", "<=", `${guildPreference.getEndCutoffYear()}-12-31`)
            .andWhere("vtype", "main")
            .orderBy("kpop_videos.app_kpop.views", "DESC")
    }

    return {
        songs: result.slice(0, guildPreference.getLimit()),
        countBeforeLimit: result.length
    };

}

const startGame = async (gameSession: GameSession, guildPreference: GuildPreference, db: Databases, message: Discord.Message, client: Discord.Client, voiceChannel?: Discord.VoiceChannel) => {
    if (!gameSession || gameSession.finished) {
        return;
    }
    if (gameSession.gameInSession()) {
        await sendErrorMessage(message, `Game already in session`, null);
        return;
    }

    try {
        let randomSong = await selectRandomSong(guildPreference, db);
        if (randomSong === null) {
            sendErrorMessage(message, "Song Query Error", "Failed to find songs matching this criteria. Try to broaden your search.");
            return;
        }
        gameSession.startRound(randomSong.name, randomSong.artist, randomSong.youtubeLink);
        await ensureVoiceConnection(message, gameSession, client, voiceChannel);
        playSong(gameSession, guildPreference, db, message, client);
    }
    catch (err) {
        await sendErrorMessage(message, "KMQ database query error", err.toString());
        logger.error(`${getDebugContext(message)} | Error querying song: ${err}. guildPreference = ${JSON.stringify(guildPreference)}`);
    }
}

const ensureVoiceConnection = async (message: Discord.Message, gameSession: GameSession, client: Discord.Client, voiceChannel?: Discord.VoiceChannel) => {
    if (voiceChannel) {
        try {
            let connection = await voiceChannel.join();
            gameSession.connection = connection;
        }
        catch (err) {
            logger.error(`${getDebugContext(message)} | Error joining voice connection. song = ${gameSession.getDebugSongDetails()} err = ${err}`);
            await sendErrorMessage(message, "Missing voice permissions", "The bot is unable to join the voice channel you are in.");
            await gameSession.endRound();
            return;
        }
    }
}
const selectRandomSong = async (guildPreference: GuildPreference, db: Databases): Promise<QueriedSong> => {
    if (isDebugMode() && isForcedSongActive()) {
        let forcePlayedQueriedSong = await getForcePlaySong(db);
        logger.debug(`Force playing ${forcePlayedQueriedSong.name} by ${forcePlayedQueriedSong.artist} | ${forcePlayedQueriedSong.youtubeLink}`);
        return forcePlayedQueriedSong;
    }
    let { songs: queriedSongList } = await getFilteredSongList(guildPreference, db);
    if (queriedSongList.length === 0) {
        return null;
    }

    let attempts = 0;
    while (true) {
        // this case should rarely happen assuming our song cache is relatively up to date
        if (attempts > 5) {
            logger.error(`Failed to select a random song: guildPref = ${JSON.stringify(guildPreference)}`);
            return null;
        }
        let random = queriedSongList[Math.floor(Math.random() * queriedSongList.length)];

        if (isDebugMode() && skipSongPlay()) {
            return random;
        }
        const songLocation = `${SONG_CACHE_DIR}/${random.youtubeLink}.mp3`;
        if (!fs.existsSync(songLocation)) {
            logger.error(`Song not cached: ${songLocation}`);
            attempts++;
            continue;
        }
        return random;
    }
}

const playSong = async (gameSession: GameSession, guildPreference: GuildPreference, db: Databases, message: Discord.Message, client: Discord.Client) => {
    if (isDebugMode() && skipSongPlay()) {
        logger.debug(`${getDebugContext(message)} | Not playing song in voice connection. song = ${gameSession.getDebugSongDetails()}`);
        return;
    }
    const songLocation = `${SONG_CACHE_DIR}/${gameSession.getVideoID()}.mp3`;

    let seekLocation: number;
    if (guildPreference.getSeekType() === SEEK_TYPES.RANDOM) {
        try {
            const songDuration = await getAudioDurationInSeconds(songLocation);
            seekLocation = songDuration * (0.6 * Math.random());
        }
        catch (e) {
            logger.error(`Failed to get mp3 length: ${songLocation}. err = ${e}`);
            seekLocation = 0;
        }
    }
    else {
        seekLocation = 0;
    }
    const streamOptions = {
        volume: guildPreference.getStreamVolume(),
        bitrate: gameSession.connection.channel.bitrate,
        seek: seekLocation
    };
    let stream: any = songLocation;
    gameSession.dispatcher = gameSession.connection.playStream(stream, streamOptions);
    logger.info(`${getDebugContext(message)} | Playing song in voice connection. seek = ${guildPreference.getSeekType()}. song = ${gameSession.getDebugSongDetails()}`);

    gameSession.dispatcher.once("end", async () => {
        logger.info(`${getDebugContext(message)} | Song finished without being guessed. song = ${gameSession.getDebugSongDetails()}`);
        await sendSongMessage(message, gameSession, true);
        await gameSession.endRound();
        startGame(gameSession, guildPreference, db, message, client, null);
    });

    gameSession.dispatcher.once("error", async () => {
        logger.error(`${getDebugContext(message)} | Unknown error with stream dispatcher. song = ${gameSession.getDebugSongDetails()}`);
        // Attempt to restart game with different song
        await sendErrorMessage(message, "Error playing song", "Starting new round in 2 seconds...");
        await gameSession.endRound();
        setTimeout(() => {
            startGame(gameSession, guildPreference, db, message, client, null);
        }, 2000);
    })
}

const cleanSongName = (name: string): string => {
    let cleanName = name.toLowerCase()
        .split("(")[0]
        .replace(/|/g, "")
        .replace(/’/, "'")
        .replace(/ /g, "").trim();
    return cleanName;
}

const getSongCount = async (guildPreference: GuildPreference, db: Databases): Promise<number> => {
    try {
        let { countBeforeLimit: totalCount } = await getFilteredSongList(guildPreference, db);
        return totalCount;
    }
    catch (e) {
        logger.error(`Error retrieving song count ${e}`);
        return -1;
    }
}

const endGame = async (gameSessions: { [guildId: string]: GameSession }, guildId: string): Promise<void> => {
    let gameSession = gameSessions[guildId];
    gameSession.finished = true;
    await gameSession.endRound();
    delete gameSessions[guildId];
}

export {
    guessSong,
    startGame,
    cleanSongName,
    getSongCount,
    GameOptions,
    endGame
}
