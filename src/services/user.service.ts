import { Transaction, Op, FindAndCountOptions } from 'sequelize';
import User, { IUser } from '../models/user.model';
import { NotFoundError, BadRequestError } from '../utils/customErrors';
import Validator from '../utils/validators';
import Pagination, { IPaging } from '../utils/pagination';
import { Sequelize } from '../models';
import UserSettings, { IUserSettings } from '../models/userSettings.model';

export interface IViewUsersQuery {
    page?: number;
    size?: number;
    q?: string;
    isBlocked?: boolean;
    isDeactivated?: boolean;
    userType?: string;
}

export interface IDynamicQueryOptions {
    query: Record<string, string>;
    includes?: 'profile' | 'all';
    attributes?: string[];
}

export default class UserService {

    static async isEmailAndUsernameAvailable(email: string, username?: string): Promise<boolean> {
        const validEmail = Validator.isValidEmail(email);
        if (!validEmail) throw new BadRequestError('Invalid email');

        let whereCondition;

        // Construct where condition based on the presence of username
        if (username) {
            whereCondition = {
                [Op.or]: [
                    { email: email },
                ],
            };
        } else {
            whereCondition = { email: email };
        }

        // Find a user with the constructed where condition
        const existingUser: User | null = await User.findOne({
            where: whereCondition,
            attributes: ['email'],
        });

        // Check if any user was found
        if (existingUser) {
            if (existingUser.email === email) {
                throw new BadRequestError('Email already in use');
            }
        }

        return true;
    }

    static async isEmailExisting(email: string): Promise<User | null> {
        const validEmail = Validator.isValidEmail(email);
        if (!validEmail) throw new BadRequestError('Invalid email');

        // Find a user with the constructed where condition
        const existingUser: User | null = await User.findOne({
            where: { email },
            attributes: ['email', 'id'],
        });

        return existingUser;

    }

    static async addUser(userData: IUser): Promise<User> {

        const _transaction = await User.create({ ...userData });

        await UserSettings.create({
            userId: _transaction.id,
            joinDate: new Date().toISOString().split('T')[0], // yyyy-mm-dd format
        } as IUserSettings);

        return _transaction;
    }

    static async viewUsers(queryData?: IViewUsersQuery): Promise<{ users: User[], count: number, totalPages?: number }> {
        const { page, size, q: query, isBlocked, isDeactivated, userType } = queryData || {};

        const where: Record<string | symbol, unknown> = {};
        const settingsWhere: Record<string, unknown> = {};

        if (query) {
            where[Op.or] = [
                { firstName: { [Op.iLike]: `%${query}%` } },
                { lastName: { [Op.iLike]: `%${query}%` } },
                { email: { [Op.iLike]: `%${query}%` } },
                Sequelize.where(Sequelize.fn('concat', Sequelize.col('User.firstName'), ' ', Sequelize.col('User.lastName')), { [Op.iLike]: `%${query}%` }),
            ];
        }

        if (isBlocked !== undefined) {
            settingsWhere.isBlocked = isBlocked;
        }

        if (isDeactivated !== undefined) {
            settingsWhere.isDeactivated = isDeactivated;
        }

        // Add filter for the user type
        if (userType) {
            where['status'] = { [Op.contains]: { userType } };
        }

        // Use the model with the appropriate scope
        const UserSettingsModel =
            userType === 'agent'
                ? UserSettings.scope('withAgentMeta')
                : UserSettings;

        const queryOptions: FindAndCountOptions<User> = {
            where,
            include: [
                {
                    model: UserSettingsModel,
                    as: 'settings',
                    where: settingsWhere,
                    // No need to specify attributes - let the scope handle it
                },
            ],
        };

        if (page && size && page > 0 && size > 0) {
            const { limit, offset } = Pagination.getPagination({ page, size } as IPaging);
            queryOptions.limit = limit ?? 0;
            queryOptions.offset = offset ?? 0;
        }

        const { rows: users, count } = await User.findAndCountAll(queryOptions);

        // Calculate the total count
        const totalCount = (count as unknown as []).length;

        if (page && size && users.length > 0) {
            const totalPages = Pagination.estimateTotalPage({ count: totalCount, limit: size } as IPaging);
            return { users, count: totalCount, ...totalPages };
        } else {
            return { users, count: totalCount };
        }
    }

    static async viewSingleUser(id: string): Promise<User> {
        const user: User | null = await User.scope('withSettings').findByPk(id);

        if (!user) {
            throw new NotFoundError('Oops User not found');
        }

        return user;
    }

    static async viewSingleUserByEmail(email: string, transaction?: Transaction): Promise<User> {
        const user: User | null = await User.findOne({
            where: { email },
            attributes: ['id', 'firstName', 'status'],
            transaction,
        });

        if (!user) {
            throw new NotFoundError('Oops User not found');
        }

        return user;
    }

    static async viewSingleUserDynamic(queryOptions: IDynamicQueryOptions): Promise<User> {
        const { query, attributes } = queryOptions;

        const user: User | null = await User.scope('withSettings').findOne({
            where: query,
            ...(attributes ? { attributes } : {}),
        });

        if (!user) {
            throw new NotFoundError('Oops User not found');
        }

        return user;
    }

    static async updateUser(user: User, dataToUpdate: Partial<IUser>): Promise<User> {
        await user.update(dataToUpdate);

        const updatedUser = await this.viewSingleUser(user.id);

        return updatedUser;
    }

    static async updateUserSettings(userId: string, settingsData: Partial<IUserSettings>): Promise<UserSettings> {
        const userSettings = await UserSettings.findOne({ where: { userId } });
        
        if (!userSettings) {
            throw new NotFoundError('User settings not found');
        }
        
        await userSettings.update(settingsData);
        return userSettings;
    }

    static async deleteUser(user: User, transaction?: Transaction): Promise<void> {
        transaction ? await user.destroy({ transaction }) : await user.destroy();
    }

    static async findOrCreateUserByGoogleProfile(profileData: {
        email: string;
        firstName: string;
        lastName: string;
        username?: string;
        googleId: string;
        displayImage?: string;
        status: {
            activated: boolean;
            emailVerified: boolean;
        };
    }): Promise<User> {
        // Check if user with this email already exists
        const user = await User.findOne({
            where: { email: profileData.email },
        });

        if (user) {
            // User exists, update googleId if not already set
            if (!user.googleId) {
                await user.update({
                    googleId: profileData.googleId,
                    displayImage: profileData.displayImage ?? user.displayImage,
                });
            }
            
            // Update email verification status if not already verified
            if (!user.status.emailVerified) {
                await user.update({
                    status: {
                        ...user.status,
                        emailVerified: true,
                    },
                });
            }
            
            return user;
        }

        // Create a new user
        const newUserData: IUser = {
            email: profileData.email,
            firstName: profileData.firstName,
            lastName: profileData.lastName,
            displayImage: profileData.displayImage,
            googleId: profileData.googleId,
            status: {
                userType: 'customer',
                emailVerified: true,
                activated: true,
            },
        };

        // Create the user
        const newUser = await this.addUser(newUserData);
        return newUser;
    }
}