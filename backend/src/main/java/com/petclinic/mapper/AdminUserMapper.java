package com.petclinic.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.petclinic.entity.AdminUser;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface AdminUserMapper extends BaseMapper<AdminUser> {

    /** 见 SysUserMapper 同名方法的说明：密码列默认不查，登录时显式取 */
    @Select("SELECT * FROM admin_user WHERE username = #{username} AND deleted = 0")
    AdminUser selectForLogin(@Param("username") String username);

    @Select("SELECT * FROM admin_user WHERE id = #{id} AND deleted = 0")
    AdminUser selectWithPassword(@Param("id") Long id);
}
