import Eris from "eris";
import { getDebugContext, sendErrorMessage } from "./discord_utils";
import { ParsedMessage } from "../types";
import { CommandValidations } from "../commands/base_command";
import _logger from "../logger";

const logger = _logger("validate");

async function sendValidationErrorMessage(message: Eris.Message<Eris.GuildTextableChannel>, warning: string, arg: string | Array<string>) {
    await sendErrorMessage(message, "Input validation error", warning);
    logger.warn(`${getDebugContext(message)} | ${warning}. val = ${arg}`);
}

function arrayToString(arr: Array<string>): string {
    const elements = arr.map((element) => `\`${element}\``);
    if (elements.length === 1) return elements[0];
    const lastElement = elements.splice(-1);
    return `${elements.join(", ")} and ${lastElement}`;
}

export default (message: Eris.Message<Eris.GuildTextableChannel>, parsedMessage: ParsedMessage, validations: CommandValidations) => {
    if (!validations) return true;
    const args = parsedMessage.components;
    if (args.length > validations.maxArgCount || args.length < validations.minArgCount) {
        sendValidationErrorMessage(message,
            `Incorrect number of arguments. See \`${process.env.BOT_PREFIX}help ${parsedMessage.action}\` for usage.`,
            args);
        return false;
    }
    for (let i = 0; i < args.length; i++) {
        const validation = validations.arguments[i];
        let arg = args[i];
        // check arg type
        switch (validation.type) {
            case "number": {
                if (Number.isNaN(Number(arg))) {
                    sendValidationErrorMessage(message,
                        `Expected numeric value for \`${validation.name}\`.`,
                        arg);
                    return false;
                }
                // parse as integer for now, might cause problems later?
                const intArg = parseInt(arg, 10);
                if ("minValue" in validation && intArg < validation.minValue) {
                    sendValidationErrorMessage(message,
                        `Expected value greater than \`${validation.minValue}\` for \`${validation.name}\`.`,
                        arg);
                    return false;
                }
                if ("maxValue" in validation && intArg > validation.maxValue) {
                    sendValidationErrorMessage(message,
                        `Expected value less than or equal to \`${validation.maxValue}\` for \`${validation.name}\`.`,
                        arg);
                    return false;
                }
                break;
            }
            case "boolean": {
                arg = arg.toLowerCase();
                if (!(arg === "false" || arg === "true")) {
                    sendValidationErrorMessage(message,
                        `Expected true/false value for \`${validation.name}\`.`,
                        arg);
                    return false;
                }
                break;
            }
            case "enum": {
                const { enums } = validation;
                arg = arg.toLowerCase();
                if (!enums.includes(arg)) {
                    sendValidationErrorMessage(message,
                        `Expected one of the following valid \`${validation.name}\` values: (${arrayToString(enums)}).`,
                        arg);
                    return false;
                }
                args[i] = arg;
                break;
            }
            case "char": {
                if (arg.length !== 1) {
                    sendValidationErrorMessage(message,
                        `Expected a character for \`${validation.name}\`.`,
                        arg);
                    return false;
                }
                break;
            }
            default: {
                logger.error(`Undefined argument type. ${validation}`);
            }
        }
    }
    return true;
};
